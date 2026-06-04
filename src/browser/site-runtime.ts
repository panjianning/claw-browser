import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join, relative } from 'path';

const COMMUNITY_REPO = 'https://github.com/panjianning/claw-sites.git';

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
  ownerId?: string;
  name?: string;
  query?: string;
  mode?: 'auto' | 'pull' | 'clone';
  args?: Record<string, unknown>;
  argv?: string[];
  tabId?: string;
  entryUrl?: string;
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


function normalizeSiteName(filePath: string, baseDir: string): string {
  return relative(baseDir, filePath).replace(/\\/g, '/').replace(/\.js$/i, '');
}

function domainMatches(host: string, domain: string): boolean {
  const loweredHost = host.trim().toLowerCase();
  const loweredDomain = domain.trim().toLowerCase();
  return loweredHost === loweredDomain || loweredHost.endsWith(`.${loweredDomain}`);
}

export class SiteRuntime {
  constructor(
    private readonly context: SiteRuntimeContext,
    private readonly defaultSession = 'default',
    private readonly ownership?: {
      acquireTabForOwner(ownerId: string, options?: { preferredTabId?: string; createIfMissing?: boolean; initialUrl?: string }): Promise<{ tabId: string; created: boolean }>;
      enforceTabOwnership(ownerId: string, tabId: string): Promise<void>;
      syncWithBrowser(): Promise<void>;
    }
  ) {}

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
        ownerId: typeof input.ownerId === 'string' ? input.ownerId : undefined,
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

  private async runSiteAdapter(input: {
    name: string;
    args?: Record<string, unknown>;
    argv?: string[];
    tabId?: string;
    entryUrl?: string;
    ownerId?: string;
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
    const ownerId = typeof input.ownerId === 'string' ? input.ownerId.trim() : '';

    if (this.ownership) {
      await this.ownership.syncWithBrowser();
      if (ownerId) {
        const initialUrl = targetUrl || (site.domain ? `https://${site.domain.trim().toLowerCase()}` : undefined);
        const acquired = await this.ownership.acquireTabForOwner(ownerId, {
          preferredTabId: targetTabId,
          createIfMissing: true,
          initialUrl,
        });
        targetTabId = acquired.tabId;
      } else if (targetTabId) {
        // Manual site runs without owner can still target an unowned tab.
      } else {
        const tabs = this.context.listTabs();
        const byDomain = targetUrl
          ? tabs.find((tab) => {
              try {
                const host = new URL(tab.url).hostname;
                return site.domain ? domainMatches(host, site.domain) : true;
              } catch {
                return false;
              }
            })
          : tabs[0];
        if (byDomain?.tabId) {
          targetTabId = byDomain.tabId;
        }
      }
    }

    if (!targetTabId && site.domain) {
      const created = await this.context.createTab(`https://${site.domain.trim().toLowerCase()}`);
      targetTabId = created;
      if (this.ownership && ownerId) {
        await this.ownership.enforceTabOwnership(ownerId, targetTabId);
      }
    }

    if (!targetTabId) {
      throw new Error('Missing tabId for site run. Provide tabId or run inside pipeline context.');
    }

    if (this.ownership && ownerId) {
      await this.ownership.enforceTabOwnership(ownerId, targetTabId);
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
  }
}
