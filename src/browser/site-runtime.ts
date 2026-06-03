import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join, relative } from 'path';

const COMMUNITY_REPO = 'https://github.com/panjianning/claw-sites.git';
const DEFAULT_SITE_DOMAIN_MAX_TABS = 2;
const SITE_POOL_LOCK_TIMEOUT_MS = 60_000;
const SITE_POOL_RETRY_MS = 120;
const SITE_POOL_STALE_LOCK_MAX_AGE_MS = 5 * 60_000;

type SiteSource = 'local' | 'community';

type SiteArgDef = {
  required?: boolean;
  description?: string;
  default?: unknown;
};

type SiteNavigationDef = {
  required?: boolean;
  sameDomain?: boolean;
};

type SiteMeta = {
  name: string;
  description: string;
  domain: string;
  args: Record<string, SiteArgDef>;
  navigation?: SiteNavigationDef;
  capabilities?: string[];
  readOnly?: boolean;
  example?: string;
  filePath: string;
  source: SiteSource;
};

type TabInfo = {
  tabId: string;
  title: string;
  url: string;
  active: boolean;
};

type SiteRuntimeContext = {
  listTabs: () => TabInfo[];
  createTab: (url: string) => Promise<string>;
  closeTab: (tabId: string) => Promise<void>;
  activateTab: (tabId: string) => Promise<void>;
  navigateTab: (tabId: string, url: string) => Promise<void>;
  executeScriptInTab: (tabId: string, script: string) => Promise<unknown>;
};

export type SiteActionRequest = {
  action: 'list' | 'search' | 'info' | 'update' | 'run';
  workingDir?: string;
  sessionId?: string;
  name?: string;
  query?: string;
  mode?: 'auto' | 'pull' | 'clone';
  args?: Record<string, unknown>;
  argv?: string[];
  tabId?: string;
  entryUrl?: string;
};

type DomainLease = {
  leaseId: string;
  pid: number;
  tabId: string;
  createdTemp: boolean;
  acquiredAt: number;
};

type DomainPoolEntry = {
  queue: string[];
  leases: DomainLease[];
};

type DomainPoolState = {
  version: 1;
  domains: Record<string, DomainPoolEntry>;
};

type PoolLockOwner = {
  pid: number;
  acquiredAt: number;
};

type SiteTabLease = {
  session: string;
  domain: string;
  leaseId: string;
  tabId: string;
  createdTemp: boolean;
};

function getClawBrowserDir(): string {
  return join(homedir(), '.claw-browser');
}

function getClawLocalSitesDir(): string {
  return join(getClawBrowserDir(), 'sites');
}

function getClawCommunitySitesDir(): string {
  return join(getClawBrowserDir(), 'claw-sites');
}

function getGemLocalSitesDir(): string {
  return join(homedir(), '.claw-browser', 'sites', 'local');
}

function getGemCommunitySitesDir(): string {
  return join(homedir(), '.claw-browser', 'sites', 'community');
}

function getSitePoolDir(): string {
  return join(getClawBrowserDir(), 'site-tab-pool');
}

function getSitePoolStatePath(session: string): string {
  return join(getSitePoolDir(), `${session}.json`);
}

function getSitePoolLockPath(session: string): string {
  return join(getSitePoolDir(), `${session}.lock`);
}

function getSitePoolLockOwnerPath(lockPath: string): string {
  return join(lockPath, 'owner.json');
}

function normalizeSiteName(filePath: string, baseDir: string): string {
  return relative(baseDir, filePath).replace(/\\/g, '/').replace(/\.js$/i, '');
}

function domainMatches(host: string, domain: string): boolean {
  const loweredHost = host.trim().toLowerCase();
  const loweredDomain = domain.trim().toLowerCase();
  return loweredHost === loweredDomain || loweredHost.endsWith(`.${loweredDomain}`);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMaxTabsPerDomain(): number {
  const raw = process.env.CLAW_BROWSER_SITE_MAX_TABS_PER_DOMAIN;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_SITE_DOMAIN_MAX_TABS;
}

function getStaleLockMaxAgeMs(): number {
  const raw = process.env.CLAW_BROWSER_SITE_LOCK_STALE_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return SITE_POOL_STALE_LOCK_MAX_AGE_MS;
}

function ensurePoolDirs(): void {
  mkdirSync(getSitePoolDir(), { recursive: true });
}

function defaultPoolState(): DomainPoolState {
  return { version: 1, domains: {} };
}

function loadPoolState(session: string): DomainPoolState {
  const statePath = getSitePoolStatePath(session);
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DomainPoolState>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.domains !== 'object') {
      return defaultPoolState();
    }
    return { version: 1, domains: parsed.domains || {} };
  } catch {
    return defaultPoolState();
  }
}

function savePoolState(session: string, state: DomainPoolState): void {
  ensurePoolDirs();
  writeFileSync(getSitePoolStatePath(session), JSON.stringify(state), 'utf-8');
}

function cleanupPoolState(state: DomainPoolState): void {
  for (const [domain, entry] of Object.entries(state.domains)) {
    const aliveLeases = entry.leases.filter((lease) => processAlive(lease.pid));
    const aliveLeaseIds = new Set(aliveLeases.map((lease) => lease.leaseId));
    const dedupQueue: string[] = [];
    for (const leaseId of entry.queue) {
      if (aliveLeaseIds.has(leaseId) && !dedupQueue.includes(leaseId)) {
        dedupQueue.push(leaseId);
      }
    }
    entry.leases = aliveLeases;
    entry.queue = dedupQueue;
    if (entry.leases.length === 0 && entry.queue.length === 0) {
      delete state.domains[domain];
    }
  }
}

async function withPoolLock<T>(session: string, fn: () => Promise<T>): Promise<T> {
  ensurePoolDirs();
  const lockPath = getSitePoolLockPath(session);
  const ownerPath = getSitePoolLockOwnerPath(lockPath);
  const startedAt = Date.now();
  const staleLockMaxAgeMs = getStaleLockMaxAgeMs();

  const writeLockOwner = (): void => {
    const owner: PoolLockOwner = { pid: process.pid, acquiredAt: Date.now() };
    writeFileSync(ownerPath, JSON.stringify(owner), 'utf-8');
  };

  const lockOwnerPid = (): number | null => {
    try {
      const raw = readFileSync(ownerPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PoolLockOwner>;
      if (typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        return parsed.pid;
      }
      return null;
    } catch {
      return null;
    }
  };

  const tryRecoverStaleLock = (): boolean => {
    try {
      const pid = lockOwnerPid();
      if (pid !== null && !processAlive(pid)) {
        return true;
      }
      const lockStat = statSync(lockPath);
      const ageMs = Date.now() - lockStat.mtimeMs;
      if (ageMs > staleLockMaxAgeMs) {
        return true;
      }
    } catch {
      // ignored
    }
    return false;
  };

  while (true) {
    try {
      mkdirSync(lockPath);
      writeLockOwner();
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (tryRecoverStaleLock()) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // ignored
        }
        continue;
      }
      if (Date.now() - startedAt > SITE_POOL_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for site pool lock (${session})`);
      }
      await sleep(SITE_POOL_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // ignored
    }
  }
}

export class SiteRuntime {
  constructor(private readonly context: SiteRuntimeContext, private readonly defaultSession = 'default') {}

  async execute(input: SiteActionRequest): Promise<unknown> {
    const workingDir = typeof input.workingDir === 'string' && input.workingDir.trim() ? input.workingDir.trim() : '';

    if (input.action === 'list') {
      return this.getAllSites(workingDir).map((site) => ({
        name: site.name,
        description: site.description,
        domain: site.domain,
        args: site.args,
        navigation: site.navigation,
        source: site.source,
        readOnly: site.readOnly,
        example: site.example,
        filePath: site.filePath,
      }));
    }

    if (input.action === 'search') {
      const query = String(input.query || '').trim().toLowerCase();
      if (!query) throw new Error('site search requires query');
      return this.getAllSites(workingDir)
        .filter((site) => {
          return (
            site.name.toLowerCase().includes(query) ||
            site.description.toLowerCase().includes(query) ||
            site.domain.toLowerCase().includes(query)
          );
        })
        .map((site) => ({
          name: site.name,
          description: site.description,
          domain: site.domain,
          args: site.args,
          navigation: site.navigation,
          source: site.source,
          filePath: site.filePath,
        }));
    }

    if (input.action === 'info') {
      const name = String(input.name || '').trim();
      if (!name) throw new Error('site info requires name');
      const sites = this.getAllSites(workingDir);
      const site = sites.find((item) => item.name === name);
      if (site) {
        return {
          name: site.name,
          description: site.description,
          domain: site.domain,
          args: site.args,
          navigation: site.navigation,
          source: site.source,
          readOnly: site.readOnly,
          example: site.example,
          filePath: site.filePath,
        };
      }

      const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
      const group = sites.filter((s) => s.name.startsWith(`${normalized}/`));
      if (group.length > 0) {
        return {
          platform: normalized,
          adapters: group.map((s) => ({
            name: s.name,
            description: s.description,
            domain: s.domain,
            navigation: s.navigation,
            source: s.source,
            filePath: s.filePath,
          })),
        };
      }
      throw new Error(`site info: adapter "${name}" not found`);
    }

    if (input.action === 'update') {
      return this.runSiteUpdate(input.mode);
    }

    if (input.action === 'run') {
      return this.runSiteAdapter({
        name: String(input.name || ''),
        args: input.args,
        argv: input.argv,
        tabId: typeof input.tabId === 'string' ? input.tabId : undefined,
        entryUrl: typeof input.entryUrl === 'string' ? input.entryUrl : undefined,
        sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : this.defaultSession,
        workingDir,
      });
    }

    throw new Error(`Unknown site action: ${String(input.action || '')}`);
  }

  private runSiteUpdate(modeInput?: 'auto' | 'pull' | 'clone'): unknown {
    const mode = modeInput || 'auto';
    if (!['auto', 'pull', 'clone'].includes(mode)) {
      throw new Error(`site update mode must be one of auto/pull/clone, got: ${mode}`);
    }

    const communityDir = getClawCommunitySitesDir();
    mkdirSync(getClawBrowserDir(), { recursive: true });

    const hasGit = existsSync(join(communityDir, '.git'));
    const updateMode = mode === 'pull' ? 'pull' : mode === 'clone' ? 'clone' : hasGit ? 'pull' : 'clone';

    if (updateMode === 'pull' && !hasGit) {
      throw new Error(`site update: cannot pull because repo does not exist at ${communityDir}`);
    }
    if (updateMode === 'clone' && hasGit) {
      throw new Error(`site update: cannot clone because repo already exists at ${communityDir}`);
    }

    const result =
      updateMode === 'pull'
        ? spawnSync('git', ['pull', '--ff-only'], {
            cwd: communityDir,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawnSync('git', ['clone', COMMUNITY_REPO, communityDir], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });

    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      throw new Error(`${updateMode === 'pull' ? 'Update' : 'Clone'} failed: ${stderr || 'git command failed'}`);
    }

    const siteCount = this.scanSites(communityDir, 'community').length;
    return {
      success: true,
      updateMode,
      communityRepo: COMMUNITY_REPO,
      communityDir,
      siteCount,
    };
  }

  private getAllSites(workingDir: string): SiteMeta[] {
    const clawCommunity = this.scanSites(getClawCommunitySitesDir(), 'community');
    const clawLocal = this.scanSites(getClawLocalSitesDir(), 'local');
    const gemCommunity = this.scanSites(getGemCommunitySitesDir(), 'community');
    const gemLocal = this.scanSites(getGemLocalSitesDir(), 'local');
    const workdirLocal = workingDir ? this.scanSites(join(workingDir, '.claw-browser', 'sites'), 'local') : [];

    const byName = new Map<string, SiteMeta>();
    for (const site of clawCommunity) byName.set(site.name, site);
    for (const site of clawLocal) byName.set(site.name, site);
    for (const site of gemCommunity) byName.set(site.name, site);
    for (const site of gemLocal) byName.set(site.name, site);
    for (const site of workdirLocal) byName.set(site.name, site);

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private scanSites(dir: string, source: SiteSource, sourceRoot = dir): SiteMeta[] {
    if (!existsSync(dir)) return [];
    const sites: SiteMeta[] = [];

    const walk = (currentDir: string): void => {
      let entries: import('fs').Dirent[] = [];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue;
          walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

        const meta = this.parseSiteMeta(fullPath, source, sourceRoot);
        if (meta) sites.push(meta);
      }
    };

    walk(dir);
    return sites;
  }

  private parseSiteMeta(filePath: string, source: SiteSource, sourceRoot: string): SiteMeta | null {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const defaultName = normalizeSiteName(filePath, sourceRoot);

    const metaMatch = content.match(/\/\*\s*@meta\s*\n([\s\S]*?)\*\//);
    if (metaMatch?.[1]) {
      try {
        const parsed = JSON.parse(metaMatch[1]) as Partial<SiteMeta>;
        return {
          name: parsed.name || defaultName,
          description: parsed.description || '',
          domain: parsed.domain || '',
          args: parsed.args || {},
          navigation: parsed.navigation && typeof parsed.navigation === 'object' ? parsed.navigation : undefined,
          capabilities: parsed.capabilities,
          readOnly: parsed.readOnly,
          example: parsed.example,
          filePath,
          source,
        };
      } catch {
        return null;
      }
    }

    const meta: SiteMeta = {
      name: defaultName,
      description: '',
      domain: '',
      args: {},
      navigation: undefined,
      capabilities: undefined,
      readOnly: undefined,
      example: undefined,
      filePath,
      source,
    };

    const tagRegex = /^\s*\/\/\s*@(\w+)\s+(.+)$/;
    for (const line of content.split('\n')) {
      const match = line.match(tagRegex);
      if (!match) continue;

      const key = match[1];
      const value = match[2].trim();
      if (key === 'name') meta.name = value;
      if (key === 'description') meta.description = value;
      if (key === 'domain') meta.domain = value;
      if (key === 'example') meta.example = value;
      if (key === 'args') {
        const argNames = value.split(/[\s,]+/).filter((item) => item.length > 0);
        for (const argName of argNames) {
          meta.args[argName] = { required: true, description: '' };
        }
      }
    }

    return meta;
  }

  private buildAdapterScript(filePath: string, argMap: Record<string, string>): string {
    const jsContent = readFileSync(filePath, 'utf-8');
    const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//g, '').trim();
    return `(${jsBody})(${JSON.stringify(argMap)})`;
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private resolveTargetUrlForSite(site: SiteMeta, rawUrl?: string): string | null {
    const requested = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (requested) {
      if (site.domain && site.navigation?.sameDomain !== false) {
        let host = '';
        try {
          host = new URL(requested).hostname;
        } catch {
          throw new Error(`Invalid --entryUrl for adapter '${site.name}': ${requested}`);
        }
        if (!domainMatches(host, site.domain)) {
          throw new Error(
            `entryUrl host (${host}) must match adapter domain (${site.domain}) for '${site.name}'`
          );
        }
      }
      return requested;
    }

    if (site.navigation?.required) {
      throw new Error(`Missing required argument 'entryUrl' for adapter '${site.name}'`);
    }
    if (!site.domain) return null;
    return `https://${site.domain.trim().toLowerCase()}`;
  }

  private buildAdapterArgMap(site: SiteMeta, input: { args?: Record<string, unknown>; argv?: string[] }): Record<string, string> {
    if (input.args && typeof input.args === 'object' && !Array.isArray(input.args)) {
      const argMap: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.args)) {
        if (value !== undefined && value !== null) {
          argMap[key] = String(value);
        }
      }
      this.applyDefaultArgs(site, argMap);
      this.assertRequiredArgs(site, argMap);
      return argMap;
    }

    const argv = Array.isArray(input.argv) ? input.argv.map((item) => String(item)) : [];
    const argMap: Record<string, string> = {};
    const positional: string[] = [];

    let idx = 0;
    while (idx < argv.length) {
      const token = argv[idx];
      if (token.startsWith('--')) {
        const key = token.replace(/^--/, '');
        if (Object.prototype.hasOwnProperty.call(site.args, key) && idx + 1 < argv.length) {
          argMap[key] = argv[idx + 1];
          idx += 2;
          continue;
        }
      }
      positional.push(token);
      idx += 1;
    }

    const argNames = Object.keys(site.args);
    let position = 0;
    for (const argName of argNames) {
      if (argMap[argName] === undefined && position < positional.length) {
        argMap[argName] = positional[position];
        position += 1;
      }
    }

    this.applyDefaultArgs(site, argMap);
    this.assertRequiredArgs(site, argMap);
    return argMap;
  }

  private applyDefaultArgs(site: SiteMeta, argMap: Record<string, string>): void {
    for (const [argName, argDef] of Object.entries(site.args)) {
      if (argMap[argName] !== undefined) continue;
      if (argDef.default !== undefined && argDef.default !== null) {
        argMap[argName] = String(argDef.default);
      }
    }
  }

  private assertRequiredArgs(site: SiteMeta, argMap: Record<string, string>): void {
    for (const [argName, argDef] of Object.entries(site.args)) {
      const value = argMap[argName];
      const missing = value === undefined || value.trim() === '';
      if (argDef.required && missing) {
        throw new Error(`Missing required argument '${argName}' for adapter '${site.name}'`);
      }
    }
  }

  private async acquireDomainTabLease(session: string, domainInput: string): Promise<SiteTabLease> {
    const domain = domainInput.trim().toLowerCase();
    const leaseId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const maxTabs = getMaxTabsPerDomain();

    const matchingDomainTabIds = (): string[] => {
      const tabs = this.context.listTabs();
      const matched: string[] = [];
      for (const tab of tabs) {
        if (!tab.url || !tab.tabId) continue;
        try {
          const host = new URL(tab.url).hostname;
          if (domainMatches(host, domain)) matched.push(tab.tabId);
        } catch {
          // ignored
        }
      }
      return matched;
    };

    while (true) {
      let acquired: SiteTabLease | null = null;

      await withPoolLock(session, async () => {
        const state = loadPoolState(session);
        cleanupPoolState(state);

        if (!state.domains[domain]) {
          state.domains[domain] = { queue: [], leases: [] };
        }

        const entry = state.domains[domain];
        if (!entry.queue.includes(leaseId)) {
          entry.queue.push(leaseId);
        }

        if (entry.queue[0] !== leaseId) {
          savePoolState(session, state);
          return;
        }

        const busy = new Set(entry.leases.map((lease) => lease.tabId));
        const reusable = matchingDomainTabIds().find((tabId) => !busy.has(tabId));
        if (reusable) {
          entry.queue.shift();
          entry.leases.push({
            leaseId,
            pid: process.pid,
            tabId: reusable,
            createdTemp: false,
            acquiredAt: Date.now(),
          });
          savePoolState(session, state);
          acquired = { session, domain, leaseId, tabId: reusable, createdTemp: false };
          return;
        }

        if (entry.leases.length >= maxTabs) {
          savePoolState(session, state);
          return;
        }

        const tabId = await this.context.createTab(`https://${domain}`);
        entry.queue.shift();
        entry.leases.push({
          leaseId,
          pid: process.pid,
          tabId,
          createdTemp: true,
          acquiredAt: Date.now(),
        });
        savePoolState(session, state);
        acquired = { session, domain, leaseId, tabId, createdTemp: true };
      });

      if (acquired) return acquired;
      await sleep(150);
    }
  }

  private async releaseDomainTabLease(lease: SiteTabLease): Promise<void> {
    await withPoolLock(lease.session, async () => {
      const state = loadPoolState(lease.session);
      cleanupPoolState(state);
      const entry = state.domains[lease.domain];
      if (!entry) {
        savePoolState(lease.session, state);
        return;
      }

      const index = entry.leases.findIndex((item) => item.leaseId === lease.leaseId);
      if (index === -1) {
        savePoolState(lease.session, state);
        return;
      }

      const current = entry.leases[index];
      if (current.createdTemp && current.tabId) {
        await this.context.closeTab(current.tabId).catch(() => undefined);
      }

      entry.leases.splice(index, 1);
      entry.queue = entry.queue.filter((item) => item !== lease.leaseId);
      if (entry.leases.length === 0 && entry.queue.length === 0) {
        delete state.domains[lease.domain];
      }

      savePoolState(lease.session, state);
    });
  }

  private async runSiteAdapter(input: {
    name: string;
    args?: Record<string, unknown>;
    argv?: string[];
    tabId?: string;
    entryUrl?: string;
    sessionId: string;
    workingDir: string;
  }): Promise<unknown> {
    const adapterName = String(input.name || '').trim();
    if (!adapterName) throw new Error('site run requires name');

    const sites = this.getAllSites(input.workingDir);
    const site = sites.find((item) => item.name === adapterName);
    if (!site) {
      const suggestions = sites
        .filter((item) => item.name.includes(adapterName))
        .slice(0, 5)
        .map((item) => item.name);
      if (suggestions.length > 0) {
        throw new Error(`site "${adapterName}" not found. Did you mean: ${suggestions.join(', ')}`);
      }
      throw new Error(`site "${adapterName}" not found`);
    }

    const targetUrl = this.resolveTargetUrlForSite(site, input.entryUrl);
    const argMap = this.buildAdapterArgMap(site, input);
    if (targetUrl) {
      argMap.entryUrl = targetUrl;
    }

    const script = this.buildAdapterScript(site.filePath, argMap);

    let targetTabId = input.tabId;
    let managedLease: SiteTabLease | null = null;

    try {
      if (!targetTabId && site.domain) {
        managedLease = await this.acquireDomainTabLease(input.sessionId, site.domain);
        targetTabId = managedLease.tabId;
      }

      if (!targetTabId) {
        throw new Error('Missing tabId for site run. Provide tabId or use an adapter with domain.');
      }

      await this.context.activateTab(targetTabId);
      if (targetUrl) {
        await this.context.navigateTab(targetTabId, targetUrl);
      }

      const raw = await this.context.executeScriptInTab(targetTabId, script);
      const parsed = this.parseMaybeJson(raw);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const data = parsed as Record<string, unknown>;
        if (typeof data.error === 'string') {
          const hint = typeof data.hint === 'string' ? data.hint : undefined;
          throw new Error(hint ? `${data.error}\nHint: ${hint}` : data.error);
        }
      }

      return {
        adapter: site.name,
        tabId: targetTabId,
        data: parsed ?? null,
      };
    } finally {
      if (managedLease) {
        await this.releaseDomainTabLease(managedLease).catch(() => undefined);
      }
    }
  }
}
