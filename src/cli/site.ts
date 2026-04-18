import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { genId } from './commands.js';
import * as connection from '../connection/index.js';

const COMMUNITY_REPO = 'https://github.com/epiral/agent-sites.git';

interface ArgDef {
  required?: boolean;
  description?: string;
}

interface SiteMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, ArgDef>;
  capabilities?: string[];
  readOnly?: boolean;
  example?: string;
  filePath: string;
  source: 'local' | 'community';
}

export interface SiteCliOptions {
  session: string;
  jsonMode: boolean;
  version: string;
  daemonOptions: connection.DaemonOptions;
  tabId?: string;
}

function getAgentBrowserDir(): string {
  return path.join(os.homedir(), '.agent-browser');
}

function getLocalSitesDir(): string {
  return path.join(getAgentBrowserDir(), 'sites');
}

function getCommunitySitesDir(): string {
  return path.join(getAgentBrowserDir(), 'agent-sites');
}

function normalizeSiteName(filePath: string, baseDir: string): string {
  return path
    .relative(baseDir, filePath)
    .replace(/\\/g, '/')
    .replace(/\.js$/i, '');
}

function parseSiteMeta(filePath: string, source: 'local' | 'community'): SiteMeta | null {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const baseDir = source === 'local' ? getLocalSitesDir() : getCommunitySitesDir();
  const defaultName = normalizeSiteName(filePath, baseDir);

  const metaMatch = content.match(/\/\*\s*@meta\s*\n([\s\S]*?)\*\//);
  if (metaMatch && metaMatch[1]) {
    try {
      const parsed = JSON.parse(metaMatch[1]) as Partial<SiteMeta>;
      return {
        name: parsed.name || defaultName,
        description: parsed.description || '',
        domain: parsed.domain || '',
        args: parsed.args || {},
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
    capabilities: undefined,
    readOnly: undefined,
    example: undefined,
    filePath,
    source,
  };

  const tagRegex = /^\s*\/\/\s*@(\w+)\s+(.+)$/;
  for (const line of content.split('\n')) {
    const m = line.match(tagRegex);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === 'name') meta.name = value;
    if (key === 'description') meta.description = value;
    if (key === 'domain') meta.domain = value;
    if (key === 'example') meta.example = value;
    if (key === 'args') {
      const argNames = value.split(/[,\s]+/).filter((x) => x.length > 0);
      for (const argName of argNames) {
        meta.args[argName] = { required: true, description: '' };
      }
    }
  }

  return meta;
}

function scanSites(dir: string, source: 'local' | 'community'): SiteMeta[] {
  if (!fs.existsSync(dir)) return [];
  const sites: SiteMeta[] = [];

  const walk = (currentDir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const meta = parseSiteMeta(full, source);
      if (meta) {
        sites.push(meta);
      }
    }
  };

  walk(dir);
  return sites;
}

function getAllSites(): SiteMeta[] {
  const community = scanSites(getCommunitySitesDir(), 'community');
  const local = scanSites(getLocalSitesDir(), 'local');
  const byName = new Map<string, SiteMeta>();

  for (const site of community) {
    byName.set(site.name, site);
  }
  for (const site of local) {
    byName.set(site.name, site);
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function printValue(jsonMode: boolean, value: unknown): void {
  if (jsonMode) {
    console.log(JSON.stringify(value));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function formatSiteListHuman(sites: SiteMeta[]): string {
  if (sites.length === 0) {
    return [
      'No site adapters found.',
      '  Install community adapters: claw-browser site update',
      `  Local adapter directory: ${getLocalSitesDir()}`,
    ].join('\n');
  }

  const groups = new Map<string, SiteMeta[]>();
  for (const site of sites) {
    const platform = site.name.includes('/') ? site.name.split('/')[0] : site.name;
    const list = groups.get(platform) || [];
    list.push(site);
    groups.set(platform, list);
  }

  const platforms = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const platform of platforms) {
    lines.push('', `${platform}/`);
    const items = groups.get(platform) || [];
    for (const site of items) {
      const suffix = site.source === 'local' ? ' (local)' : '';
      const cmd = site.name.startsWith(`${platform}/`)
        ? site.name.slice(platform.length + 1)
        : site.name;
      const desc = site.description ? ` - ${site.description}` : '';
      lines.push(`  ${cmd.padEnd(20, ' ')}${desc}${suffix}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function parseAdapterArgs(site: SiteMeta, args: string[]): Record<string, string> {
  const argMap: Record<string, string> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token.startsWith('--')) {
      const key = token.replace(/^--/, '');
      if (Object.prototype.hasOwnProperty.call(site.args, key) && i + 1 < args.length) {
        argMap[key] = args[i + 1];
        i += 2;
        continue;
      }
    }
    positional.push(token);
    i += 1;
  }

  const argNames = Object.keys(site.args);
  let posIdx = 0;
  for (const argName of argNames) {
    if (argMap[argName] === undefined && posIdx < positional.length) {
      argMap[argName] = positional[posIdx];
      posIdx += 1;
    }
  }

  for (const [argName, argDef] of Object.entries(site.args)) {
    if (argDef.required && argMap[argName] === undefined) {
      const usageArgs = argNames
        .map((name) => (site.args[name]?.required ? `<${name}>` : `[${name}]`))
        .join(' ');
      throw new Error(
        `Missing required argument '${argName}'. Usage: claw-browser site ${site.name} ${usageArgs}`
      );
    }
  }

  return argMap;
}

function findMatchingDomainTabId(
  tabs: Array<Record<string, unknown>>,
  domain: string
): string | null {
  for (const tab of tabs) {
    const tabUrl = typeof tab.url === 'string' ? tab.url : '';
    if (!tabUrl) continue;
    try {
      const host = new URL(tabUrl).hostname;
      if (host === domain || host.endsWith(`.${domain}`)) {
        const tabId = typeof tab.tabId === 'string' ? tab.tabId : '';
        if (tabId) return tabId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function buildAdapterScript(filePath: string, argMap: Record<string, string>): string {
  const jsContent = fs.readFileSync(filePath, 'utf-8');
  const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//g, '').trim();
  return `(${jsBody})(${JSON.stringify(argMap)})`;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatAdapterResultForHuman(value: unknown): string {
  if (value === null || value === undefined) return '(no output)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

async function ensureDaemonForSiteRun(opts: SiteCliOptions): Promise<void> {
  await connection.ensureDaemon(opts.session, opts.daemonOptions, opts.version);
}

async function runSiteAdapter(
  site: SiteMeta,
  args: string[],
  opts: SiteCliOptions
): Promise<void> {
  await ensureDaemonForSiteRun(opts);
  const argMap = parseAdapterArgs(site, args);
  const script = buildAdapterScript(site.filePath, argMap);

  let targetTabId: string | undefined = opts.tabId;

  if (!targetTabId && site.domain) {
    const listResp = await connection.sendCommand(
      { id: genId(), action: 'tab_list' },
      opts.session
    );
    if (!listResp.success) {
      throw new Error(listResp.error || 'Failed to list tabs');
    }

    const tabs = Array.isArray((listResp.data as any)?.tabs)
      ? ((listResp.data as any).tabs as Array<Record<string, unknown>>)
      : [];
    targetTabId = findMatchingDomainTabId(tabs, site.domain) || undefined;

    if (!targetTabId) {
      const newResp = await connection.sendCommand(
        {
          id: genId(),
          action: 'tab_new',
          url: `https://${site.domain}`,
        },
        opts.session
      );
      if (!newResp.success) {
        throw new Error(newResp.error || `Failed to open ${site.domain}`);
      }
      targetTabId = typeof (newResp.data as any)?.tabId === 'string'
        ? (newResp.data as any).tabId
        : undefined;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  const evalCmd: Record<string, unknown> = {
    id: genId(),
    action: 'evaluate',
    script,
  };
  if (targetTabId) {
    evalCmd.tabId = targetTabId;
  }

  const evalResp = await connection.sendCommand(evalCmd, opts.session);
  if (!evalResp.success) {
    throw new Error(evalResp.error || 'Eval failed');
  }

  const rawResult = (evalResp.data as any)?.result;
  const parsed = parseMaybeJson(rawResult);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === 'string') {
      const hint = typeof obj.hint === 'string' ? obj.hint : undefined;
      throw new Error(hint ? `${obj.error}\nHint: ${hint}` : obj.error);
    }
  }

  if (opts.jsonMode) {
    printValue(true, { success: true, data: parsed ?? null });
    return;
  }

  console.log(formatAdapterResultForHuman(parsed));
}

function runSiteUpdate(jsonMode: boolean): void {
  const agentBrowserDir = getAgentBrowserDir();
  const communityDir = getCommunitySitesDir();

  fs.mkdirSync(agentBrowserDir, { recursive: true });

  const hasGit = fs.existsSync(path.join(communityDir, '.git'));
  const updateMode = hasGit ? 'pull' : 'clone';

  if (updateMode === 'pull') {
    const res = spawnSync('git', ['pull', '--ff-only'], {
      cwd: communityDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) {
      throw new Error(
        `Update failed: ${(res.stderr || '').trim() || 'git pull failed'}`
      );
    }
  } else {
    const res = spawnSync('git', ['clone', COMMUNITY_REPO, communityDir], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) {
      throw new Error(
        `Clone failed: ${(res.stderr || '').trim() || 'git clone failed'}`
      );
    }
  }

  const siteCount = scanSites(communityDir, 'community').length;
  if (jsonMode) {
    printValue(true, {
      success: true,
      updateMode,
      communityRepo: COMMUNITY_REPO,
      communityDir,
      siteCount,
    });
  } else {
    console.log(`Installed ${siteCount} community adapters.`);
  }
}

export async function runSiteCli(args: string[], opts: SiteCliOptions): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const sites = getAllSites();

  if (!sub || sub === 'list') {
    if (opts.jsonMode) {
      const items = sites.map((site) => ({
        name: site.name,
        description: site.description,
        domain: site.domain,
        args: site.args,
        source: site.source,
      }));
      printValue(true, items);
      return;
    }
    console.log(formatSiteListHuman(sites));
    return;
  }

  if (sub === 'search') {
    const query = (rest[0] || '').toLowerCase();
    if (!query) {
      throw new Error('Usage: claw-browser site search <query>');
    }
    const matches = sites.filter((site) => {
      return (
        site.name.toLowerCase().includes(query) ||
        site.description.toLowerCase().includes(query) ||
        site.domain.toLowerCase().includes(query)
      );
    });
    if (opts.jsonMode) {
      printValue(
        true,
        matches.map((site) => ({
          name: site.name,
          description: site.description,
          domain: site.domain,
          source: site.source,
        }))
      );
      return;
    }
    if (matches.length === 0) {
      console.log(`No adapters matching "${rest[0]}".`);
      return;
    }
    for (const site of matches) {
      const suffix = site.source === 'local' ? ' (local)' : '';
      console.log(`${site.name.padEnd(24, ' ')} ${site.description}${suffix}`);
    }
    return;
  }

  if (sub === 'info') {
    const name = rest[0];
    if (!name) {
      throw new Error('Usage: claw-browser site info <name>');
    }
    const site = sites.find((s) => s.name === name);
    if (!site) {
      throw new Error(`site info: adapter "${name}" not found`);
    }

    if (opts.jsonMode) {
      printValue(true, {
        name: site.name,
        description: site.description,
        domain: site.domain,
        args: site.args,
        example: site.example,
        readOnly: site.readOnly,
      });
      return;
    }

    console.log(`${site.name} - ${site.description}`);
    console.log('');
    console.log('Arguments:');
    const argEntries = Object.entries(site.args);
    if (argEntries.length === 0) {
      console.log('  (none)');
    } else {
      for (const [argName, argDef] of argEntries) {
        const required = argDef.required ? 'required' : 'optional';
        const desc = argDef.description ? ` ${argDef.description}` : '';
        console.log(`  ${argName} (${required})${desc}`);
      }
    }
    console.log('');
    console.log('Example:');
    console.log(`  ${site.example || `claw-browser site ${site.name}`}`);
    console.log('');
    console.log(`Domain: ${site.domain || '(not specified)'}`);
    console.log(`Read-only: ${site.readOnly ? 'yes' : 'no'}`);
    return;
  }

  if (sub === 'update') {
    runSiteUpdate(opts.jsonMode);
    return;
  }

  const runAdapter = sub === 'run';
  const adapterName = runAdapter ? rest[0] : sub;
  const adapterArgs = runAdapter ? rest.slice(1) : rest;
  if (!adapterName) {
    throw new Error('Usage: claw-browser site run <name> [args...]');
  }

  const site = sites.find((s) => s.name === adapterName);
  if (!site) {
    const suggestions = sites
      .filter((s) => s.name.includes(adapterName))
      .slice(0, 5)
      .map((s) => s.name);
    if (suggestions.length > 0) {
      throw new Error(
        `site "${adapterName}" not found.\nDid you mean:\n${suggestions.map((s) => `  claw-browser site ${s}`).join('\n')}`
      );
    }
    throw new Error(`site "${adapterName}" not found. Try: claw-browser site list`);
  }

  await runSiteAdapter(site, adapterArgs, opts);
}
