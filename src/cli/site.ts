import * as connection from '../connection/index.js';

interface ArgDef {
  required?: boolean;
  description?: string;
  default?: unknown;
}

interface SiteMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, ArgDef>;
  navigation?: {
    required?: boolean;
    sameDomain?: boolean;
  };
  readOnly?: boolean;
  example?: string;
  filePath?: string;
  source: 'local' | 'community';
}

export interface SiteCliOptions {
  session: string;
  jsonMode: boolean;
  version: string;
  daemonOptions: connection.DaemonOptions;
  tabId?: string;
}

function genId(): string {
  const timestamp = Date.now() * 1000 + performance.now() * 1000;
  return `r${Math.floor(timestamp % 1000000)}`;
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

function isHelpFlag(value: string | undefined): boolean {
  return value === '--help' || value === '-h';
}

function formatArgDefault(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatArgHelpLines(site: SiteMeta): string[] {
  const argEntries = Object.entries(site.args || {});
  const lines: string[] = [];

  if (site.navigation?.required) {
    lines.push('  entryUrl (required) - Entry URL for adapter navigation');
  }

  if (argEntries.length === 0 && lines.length === 0) {
    return ['  (none)'];
  }

  for (const [argName, argDef] of argEntries) {
    const required = argDef.required ? 'required' : 'optional';
    const desc = argDef.description ? ` - ${argDef.description}` : '';
    const defaultText =
      argDef.default !== undefined ? ` (default: ${formatArgDefault(argDef.default)})` : '';
    lines.push(`  ${argName} (${required})${defaultText}${desc}`);
  }

  return lines;
}

function formatSiteListHuman(sites: SiteMeta[]): string {
  if (sites.length === 0) {
    return 'No site adapters found.';
  }

  const groups = new Map<string, SiteMeta[]>();
  for (const site of sites) {
    const platform = site.name.includes('/') ? site.name.split('/')[0] : site.name;
    const list = groups.get(platform) || [];
    list.push(site);
    groups.set(platform, list);
  }

  const platforms = [...groups.keys()].sort((a, b) => a.localeCompare(b));
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

function printSiteHelp(jsonMode: boolean): void {
  const helpText = [
    'Usage:',
    '  claw-browser site [list]',
    '  claw-browser site search <query>',
    '  claw-browser site info <name>',
    '  claw-browser site update [--pull|--clone]',
    '  claw-browser site <adapter-name> [args...]',
    '  claw-browser site run <adapter-name> [args...]',
    '',
    'Tips:',
    '  claw-browser site info <name>         # show adapter arguments',
    '  claw-browser site <name> --help       # show adapter help',
    '  claw-browser site run <name> --help   # show adapter help',
  ].join('\n');

  if (jsonMode) {
    printValue(true, {
      success: true,
      usage: [
        'claw-browser site [list]',
        'claw-browser site search <query>',
        'claw-browser site info <name>',
        'claw-browser site update [--pull|--clone]',
        'claw-browser site <adapter-name> [args...]',
        'claw-browser site run <adapter-name> [args...]',
      ],
    });
    return;
  }

  console.log(helpText);
}

function printSiteUpdateHelp(jsonMode: boolean): void {
  if (jsonMode) {
    printValue(true, {
      success: true,
      usage: 'claw-browser site update [--pull|--clone]',
      options: [
        { name: '--pull', description: 'Force git pull mode; requires existing community repo clone.' },
        { name: '--clone', description: 'Force git clone mode; requires community repo to not exist.' },
      ],
    });
    return;
  }

  console.log('Usage: claw-browser site update [--pull|--clone]');
  console.log('');
  console.log('Options:');
  console.log('  --pull   Force git pull mode (requires existing community repo clone)');
  console.log('  --clone  Force git clone mode (requires community repo not cloned yet)');
}

function printSiteInfo(site: SiteMeta, jsonMode: boolean): void {
  if (jsonMode) {
    printValue(true, {
      name: site.name,
      description: site.description,
      domain: site.domain,
      args: site.args,
      navigation: site.navigation,
      example: site.example,
      readOnly: site.readOnly,
    });
    return;
  }

  console.log(`${site.name} - ${site.description}`);
  console.log('');
  console.log('Arguments:');
  for (const line of formatArgHelpLines(site)) {
    console.log(line);
  }
  console.log('');
  console.log('Example:');
  console.log(`  ${site.example || `claw-browser site ${site.name}`}`);
  console.log('');
  console.log(`Domain: ${site.domain || '(not specified)'}`);
  if (site.navigation) {
    console.log(`Navigation: required=${site.navigation.required === true}, sameDomain=${site.navigation.sameDomain !== false}`);
  }
  console.log(`Read-only: ${site.readOnly ? 'yes' : 'no'}`);
}

function parseEntryUrl(adapterArgs: string[]): { argv: string[]; entryUrl?: string } {
  const argv: string[] = [];
  let entryUrl: string | undefined;

  for (let i = 0; i < adapterArgs.length; i++) {
    const token = adapterArgs[i];
    if (token === '--entryUrl' || token === '--entry-url') {
      if (i + 1 >= adapterArgs.length) {
        throw new Error('Missing value for --entryUrl');
      }
      entryUrl = String(adapterArgs[i + 1] || '').trim();
      i += 1;
      continue;
    }
    argv.push(token);
  }

  return { argv, entryUrl };
}

async function executeSiteAction(
  siteAction: string,
  args: Record<string, unknown>,
  opts: SiteCliOptions
): Promise<unknown> {
  const send = async (): Promise<connection.Response> => {
    await connection.ensureDaemon(opts.session, opts.daemonOptions, opts.version);
    return await connection.sendCommand(
      {
        id: genId(),
        action: 'site',
        siteAction,
        args,
        sessionId: opts.session,
        workingDir: process.cwd(),
      },
      opts.session
    );
  };

  let response = await send();

  // Backward compatibility: old daemon process may still be running after local rebuild.
  if (!response.success && typeof response.error === 'string' && response.error.includes('Unknown action: site')) {
    await connection.forceStopDaemon(opts.session);
    response = await send();
  }

  if (!response.success) {
    throw new Error(response.error || `site ${siteAction} failed`);
  }

  const payload = response.data as Record<string, unknown> | undefined;
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

export async function runSiteCli(args: string[], opts: SiteCliOptions): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'help' || isHelpFlag(sub)) {
    printSiteHelp(opts.jsonMode);
    return;
  }

  if (!sub || sub === 'list') {
    const result = await executeSiteAction('list', {}, opts);
    const sites = Array.isArray(result) ? (result as SiteMeta[]) : [];
    if (opts.jsonMode) {
      printValue(true, sites);
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
    const result = await executeSiteAction('search', { query }, opts);
    const matches = Array.isArray(result) ? (result as SiteMeta[]) : [];

    if (opts.jsonMode) {
      printValue(true, matches);
      return;
    }
    if (matches.length === 0) {
      console.log(`No adapters matching "${rest[0]}".`);
      return;
    }
    for (const site of matches) {
      const suffix = site.source === 'local' ? ' (local)' : '';
      console.log(`${site.name.padEnd(24, ' ')} ${site.description || ''}${suffix}`);
    }
    return;
  }

  if (sub === 'info') {
    const name = rest[0];
    if (!name) {
      throw new Error('Usage: claw-browser site info <name>');
    }

    const result = await executeSiteAction('info', { name }, opts);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      printValue(opts.jsonMode, result);
      return;
    }

    const info = result as Record<string, unknown>;
    if (info.platform && Array.isArray(info.adapters)) {
      if (opts.jsonMode) {
        printValue(true, info);
        return;
      }
      const platform = String(info.platform || '');
      const adapters = info.adapters as Array<Record<string, unknown>>;
      console.log(`Adapters under "${platform}/":`);
      for (const adapter of adapters) {
        const desc = typeof adapter.description === 'string' && adapter.description ? ` - ${adapter.description}` : '';
        console.log(`  ${String(adapter.name || '')}${desc}`);
      }
      console.log('');
      if (adapters[0] && typeof adapters[0].name === 'string') {
        console.log('Tip: use full adapter name for argument details, e.g.:');
        console.log(`  claw-browser site info ${adapters[0].name}`);
      }
      return;
    }

    printSiteInfo(info as unknown as SiteMeta, opts.jsonMode);
    return;
  }

  if (sub === 'update') {
    if (rest.some((item) => isHelpFlag(item))) {
      printSiteUpdateHelp(opts.jsonMode);
      return;
    }

    const forcePull = rest.includes('--pull');
    const forceClone = rest.includes('--clone');
    const unknownArgs = rest.filter((item) => item !== '--pull' && item !== '--clone');
    if (unknownArgs.length > 0) {
      throw new Error(`site update: unknown option(s): ${unknownArgs.join(', ')}`);
    }
    if (forcePull && forceClone) {
      throw new Error('site update: --pull and --clone cannot be used together');
    }

    const mode = forcePull ? 'pull' : forceClone ? 'clone' : 'auto';
    const result = await executeSiteAction('update', { mode }, opts);
    printValue(opts.jsonMode, result);
    return;
  }

  const runAdapter = sub === 'run';
  const adapterName = runAdapter ? rest[0] : sub;
  const adapterArgs = runAdapter ? rest.slice(1) : rest;

  if (!adapterName) {
    throw new Error('Usage: claw-browser site run <name> [args...]');
  }

  if (adapterArgs.some((item) => isHelpFlag(item))) {
    const info = await executeSiteAction('info', { name: adapterName }, opts);
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      printSiteInfo(info as unknown as SiteMeta, opts.jsonMode);
      return;
    }
    printValue(opts.jsonMode, info);
    return;
  }

  const parsed = parseEntryUrl(adapterArgs);
  const result = await executeSiteAction(
    'run',
    {
      name: adapterName,
      argv: parsed.argv,
      entryUrl: parsed.entryUrl,
      ...(opts.tabId ? { tabId: opts.tabId } : {}),
    },
    opts
  );

  if (opts.jsonMode) {
    printValue(true, { success: true, data: result });
    return;
  }

  if (typeof result === 'string') {
    console.log(result);
    return;
  }

  printValue(false, result);
}
