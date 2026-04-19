#!/usr/bin/env node

import { parseCommand, isValidSessionName } from './cli/commands.js';
import type { Flags } from './types/commands.js';
import { InvalidSessionNameError } from './types/commands.js';
import * as connection from './connection/index.js';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get package version
function getVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );
    return packageJson.version;
  } catch {
    return '0.1.0';
  }
}

const VERSION = getVersion();

// Serialize JSON value safely
function serializeJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      success: false,
      error: 'Failed to serialize JSON response',
    });
  }
}

function printJsonValue(value: unknown): void {
  console.log(serializeJsonValue(value));
}

function printJsonError(message: string): void {
  printJsonValue({
    success: false,
    error: message,
  });
}

function printJsonErrorWithType(message: string, errorType: string): void {
  printJsonValue({
    success: false,
    error: message,
    type: errorType,
  });
}

function printHumanSuccess(command: { action?: string }, response: { data?: any }): void {
  const action = command.action || '';
  const data = response.data || {};

  if (action === 'navigate') {
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    const url = typeof data.url === 'string' ? data.url : '';
    const tabId = typeof data.tabId === 'string' ? data.tabId : '';
    if (title.length > 0 && url.length > 0) {
      console.log(`✓ ${title}`);
      console.log(`  ${url}`);
      if (tabId) {
        console.log(`  tab: ${tabId}`);
      }
      return;
    }
    if (url.length > 0) {
      console.log(url);
      if (tabId) {
        console.log(`tab: ${tabId}`);
      }
      return;
    }
  }

  if (action === 'tab_list' || action === 'listTabs') {
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i] || {};
      const marker = tab.active ? '→' : ' ';
      const tabId = typeof tab.tabId === 'string' ? tab.tabId : (typeof tab.id === 'string' ? tab.id : '');
      const shortId = typeof tab.shortId === 'string' && tab.shortId.length > 0 ? tab.shortId : `t${i + 1}`;
      const label = typeof tab.label === 'string' && tab.label.length > 0 ? tab.label : '';
      const title = typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : 'Untitled';
      const url = typeof tab.url === 'string' ? tab.url : '';
      const labelPart = label ? ` [${label}]` : '';
      console.log(`${marker} ${shortId}${labelPart} ${tabId} ${title} - ${url}`);
    }
    return;
  }

  if (
    action === 'tab_new' ||
    action === 'newTab' ||
    action === 'tab_switch' ||
    action === 'switchTab' ||
    action === 'window_new'
  ) {
    const tabId = typeof data.tabId === 'string' ? data.tabId : '';
    const shortId = typeof data.shortId === 'string' ? data.shortId : '';
    const label = typeof data.label === 'string' ? data.label : '';
    const title = typeof data.title === 'string' ? data.title : '';
    const url = typeof data.url === 'string' ? data.url : '';
    if (tabId || title || url) {
      if (title) {
        console.log(`✓ ${title}`);
      }
      if (url) {
        console.log(`  ${url}`);
      }
      if (shortId) {
        console.log(`  short: ${shortId}${label ? ` (${label})` : ''}`);
      } else if (label) {
        console.log(`  label: ${label}`);
      }
      if (tabId) {
        console.log(`  tab: ${tabId}`);
      }
      return;
    }
  }

  if (action === 'title' && typeof data.title === 'string') {
    console.log(data.title);
    return;
  }

  if (action === 'url' && typeof data.url === 'string') {
    console.log(data.url);
    return;
  }

  if (action === 'cdp_url' && typeof data.cdpUrl === 'string') {
    console.log(data.cdpUrl);
    return;
  }

  if (action === 'gettext' && typeof data.text === 'string') {
    console.log(data.text);
    return;
  }

  if (action === 'innerhtml' && typeof data.html === 'string') {
    console.log(data.html);
    return;
  }

  if (action === 'inputvalue' && typeof data.value === 'string') {
    console.log(data.value);
    return;
  }

  if (action === 'getattribute') {
    if (data.value === null || data.value === undefined) {
      console.log('');
    } else if (typeof data.value === 'string') {
      console.log(data.value);
    } else {
      console.log(String(data.value));
    }
    return;
  }

  if (action === 'count' && typeof data.count === 'number') {
    console.log(String(data.count));
    return;
  }

  if (action === 'isvisible' && typeof data.visible === 'boolean') {
    console.log(data.visible ? 'true' : 'false');
    return;
  }

  if (action === 'isenabled' && typeof data.enabled === 'boolean') {
    console.log(data.enabled ? 'true' : 'false');
    return;
  }

  if (action === 'ischecked' && typeof data.checked === 'boolean') {
    console.log(data.checked ? 'true' : 'false');
    return;
  }

  if (action === 'evaluate' && Object.prototype.hasOwnProperty.call(data, 'result')) {
    const result = data.result;
    if (typeof result === 'string') {
      console.log(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (action === 'snapshot' && typeof data.snapshot === 'string') {
    console.log(data.snapshot);
    return;
  }

  if (action === 'console' && Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      const level = typeof msg?.level === 'string' ? msg.level : 'log';
      const text = typeof msg?.text === 'string' ? msg.text : '';
      console.log(`[${level}] ${text}`);
    }
    return;
  }

  if (action === 'errors' && Array.isArray(data.errors)) {
    for (const entry of data.errors) {
      const text = typeof entry?.text === 'string' ? entry.text : '';
      console.log(text);
    }
    return;
  }

  if (action === 'network_requests' && Array.isArray(data.requests)) {
    for (const req of data.requests) {
      const method = typeof req?.method === 'string' ? req.method : 'GET';
      const url = typeof req?.url === 'string' ? req.url : '';
      const status = typeof req?.status === 'number' ? ` ${req.status}` : '';
      const requestId = typeof req?.requestId === 'string' ? req.requestId : '';
      console.log(`[${requestId}] ${method} ${url}${status}`);
    }
    return;
  }

  if (action === 'dialog' && typeof data.hasDialog === 'boolean') {
    if (!data.hasDialog) {
      console.log('No dialog is currently open');
      return;
    }
    const type = typeof data.type === 'string' ? data.type : 'unknown';
    const message = typeof data.message === 'string' ? data.message : '';
    console.log(`JavaScript ${type} dialog is open: "${message}"`);
    return;
  }

  if ((action === 'stream_enable' || action === 'stream_status') && typeof data.enabled === 'boolean') {
    if (!data.enabled) {
      console.log('Streaming disabled');
      return;
    }
    const port = typeof data.port === 'number' ? data.port : 'unknown';
    const connected = typeof data.connected === 'boolean' ? data.connected : false;
    const screencasting = typeof data.screencasting === 'boolean' ? data.screencasting : false;
    console.log(`Streaming enabled on ws://127.0.0.1:${port}`);
    console.log(`Connected: ${connected}`);
    console.log(`Screencasting: ${screencasting}`);
    return;
  }

  if (action === 'stream_disable' && data.disabled === true) {
    console.log('Streaming disabled');
    return;
  }

  if (data && Object.keys(data).length > 0) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Parse proxy string: protocol://username:password@host:port
interface ParsedProxy {
  server: string;
  username?: string;
  password?: string;
}

interface CdpTarget {
  cdpPort?: number;
  cdpUrl?: string;
}

function parseProxy(proxyStr: string): ParsedProxy {
  const protocolMatch = proxyStr.match(/^(\w+:\/\/)/);
  if (!protocolMatch) {
    return { server: proxyStr };
  }

  const protocol = protocolMatch[1];
  const rest = proxyStr.slice(protocol.length);

  const atPos = rest.lastIndexOf('@');
  if (atPos === -1) {
    return { server: proxyStr };
  }

  const creds = rest.slice(0, atPos);
  const serverPart = rest.slice(atPos + 1);
  const server = `${protocol}${serverPart}`;

  const colonPos = creds.indexOf(':');
  let username: string | undefined;
  let password: string | undefined;

  if (colonPos !== -1) {
    const u = creds.slice(0, colonPos);
    const p = creds.slice(colonPos + 1);
    username = u.length > 0 ? u : undefined;
    password = p.length > 0 ? p : undefined;
  } else {
    username = creds.length > 0 ? creds : undefined;
  }

  return { server, username, password };
}

function parseCdpTarget(value: string): CdpTarget {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('CDP endpoint cannot be empty');
  }

  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid CDP port: ${trimmed}`);
    }
    return { cdpPort: port };
  }

  return { cdpUrl: trimmed };
}

function getDefaultSession(flags: Flags): string {
  const fromFlag = typeof flags.session === 'string' ? flags.session.trim() : '';
  if (fromFlag.length > 0) return fromFlag;
  const fromEnv = (process.env.CLAW_BROWSER_SESSION || '').trim();
  if (fromEnv.length > 0) return fromEnv;
  return 'default';
}

async function stopSession(session: string): Promise<boolean> {
  let gracefulStopped = false;
  if (connection.daemonReady(session)) {
    try {
      const closeResponse = await connection.sendCommand(
        { id: `stop-${Date.now()}`, action: 'close' },
        session
      );
      gracefulStopped = Boolean(closeResponse.success);
    } catch {
      // fall through
    }
  }
  if (!gracefulStopped) {
    await connection.forceStopDaemon(session);
  }
  connection.cleanupStaleFiles(session);
  return gracefulStopped;
}

function getChromeUserDataDir(): string | null {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    return join(local, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (!home) return null;
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  const home = process.env.HOME;
  if (!home) return null;
  return join(home, '.config', 'google-chrome');
}

function listChromeProfiles(): Array<{ dir: string; name: string }> {
  const userDataDir = getChromeUserDataDir();
  if (!userDataDir || !existsSync(userDataDir)) {
    return [];
  }

  const localStatePath = join(userDataDir, 'Local State');
  let nameMap = new Map<string, string>();
  try {
    const localState = JSON.parse(readFileSync(localStatePath, 'utf-8'));
    const infoCache = localState?.profile?.info_cache || {};
    nameMap = new Map<string, string>(
      Object.entries(infoCache).map(([dir, info]: [string, any]) => [dir, info?.name || dir])
    );
  } catch {
    // ignore
  }

  const entries: Array<{ dir: string; name: string }> = [];
  try {
    for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = entry.name;
      if (dir === 'Default' || /^Profile \d+$/i.test(dir)) {
        entries.push({ dir, name: nameMap.get(dir) || dir });
      }
    }
  } catch {
    return [];
  }

  return entries.sort((a, b) => a.dir.localeCompare(b.dir));
}

// Parse global CLI flags and keep command-level flags in argv
function parseFlags(args: string[]): { flags: Flags; cleanedArgs: string[] } {
  const flags: Flags = {};
  const cleanedArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--provider') {
      flags.provider = args[i + 1];
      i++;
    } else if (arg === '--device') {
      flags.device = args[i + 1];
      i++;
    } else if (arg === '--headers') {
      flags.headers = args[i + 1];
      i++;
    } else if (arg === '--default-timeout') {
      flags.defaultTimeout = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--annotate') {
      flags.cliAnnotate = true;
    } else if (arg === '--headed') {
      flags.headed = true;
    } else if (arg === '--cdp') {
      flags.cdp = args[i + 1];
      i++;
    } else if (arg === '--tab-id') {
      flags.tabId = args[i + 1];
      i++;
    } else if (arg === '--session') {
      flags.session = args[i + 1];
      i++;
    } else if (arg === '--profile') {
      flags.profile = args[i + 1];
      i++;
    } else if (arg === '--json' || arg === '-j') {
      flags.json = true;
    } else {
      cleanedArgs.push(arg);
    }
  }

  return { flags, cleanedArgs };
}

async function main() {
  const args = process.argv.slice(2);

  // Check if we're running in daemon mode
  if (process.env.CLAW_BROWSER_DAEMON === '1') {
    console.error('[index] Daemon mode detected, starting daemon...');
    // Import and run daemon
    const { runDaemon } = await import('./daemon/index.js');
    const session = process.env.CLAW_BROWSER_SESSION || 'default';
    console.error(`[index] Calling runDaemon for session: ${session}`);
    await runDaemon({
      session,
      idleTimeoutMs: process.env.CLAW_BROWSER_IDLE_TIMEOUT_MS
        ? parseInt(process.env.CLAW_BROWSER_IDLE_TIMEOUT_MS)
        : undefined,
      debug: process.env.CLAW_BROWSER_DEBUG === '1',
    });
    console.error('[index] runDaemon returned');
    return;
  }

  // Parse flags and clean args
  const { flags, cleanedArgs } = parseFlags(args);
  const defaultSession = getDefaultSession(flags);

  // JSON output mode
  const jsonMode = flags.json || process.env.CLAW_BROWSER_JSON === '1';

  // Handle built-in commands
  if (cleanedArgs.length === 0 || cleanedArgs[0] === 'help' || cleanedArgs[0] === '--help' || cleanedArgs[0] === '-h') {
    printHelp();
    return;
  }

  if (cleanedArgs[0] === 'version' || cleanedArgs[0] === '--version' || cleanedArgs[0] === '-v') {
    if (jsonMode) {
      printJsonValue({ success: true, version: VERSION });
    } else {
      console.log(`claw-browser v${VERSION}`);
    }
    return;
  }

  if (cleanedArgs[0] === 'start') {
    // Start daemon session
    const session = cleanedArgs[1] || defaultSession;

    if (!isValidSessionName(session)) {
      if (jsonMode) {
        printJsonErrorWithType(
          `Invalid session name: ${session}. Session names must not contain path separators or invalid characters`,
          'InvalidSessionName'
        );
      } else {
        console.error(`Invalid session name: ${session}`);
      }
      process.exit(1);
    }

    try {
      const opts: connection.DaemonOptions = {
        headed: flags.headed || false,
        debug: process.env.CLAW_BROWSER_DEBUG === '1',
        profile: flags.profile,
      };

      // Parse proxy if provided
      if (flags.provider === 'proxy' && process.env.CLAW_BROWSER_PROXY) {
        const parsed = parseProxy(process.env.CLAW_BROWSER_PROXY);
        opts.proxy = parsed.server;
        opts.proxyUsername = parsed.username;
        opts.proxyPassword = parsed.password;
      }

      const result = await connection.ensureDaemon(session, opts, VERSION);

      if (jsonMode) {
        printJsonValue({
          success: true,
          session,
          alreadyRunning: result.alreadyRunning,
        });
      } else {
        if (result.alreadyRunning) {
          console.log(`Session '${session}' is already running`);
        } else {
          console.log(`Started session '${session}'`);
        }
      }
    } catch (e) {
      if (jsonMode) {
        printJsonError(e instanceof Error ? e.message : String(e));
      } else {
        console.error(`Failed to start session: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (cleanedArgs[0] === 'stop') {
    // Stop daemon session
    const session = cleanedArgs[1] || defaultSession;

    if (!isValidSessionName(session)) {
      if (jsonMode) {
        printJsonErrorWithType(
          `Invalid session name: ${session}`,
          'InvalidSessionName'
        );
      } else {
        console.error(`Invalid session name: ${session}`);
      }
      process.exit(1);
    }

    try {
      const gracefulStopped = await stopSession(session);

      if (jsonMode) {
        printJsonValue({ success: true, session, graceful: gracefulStopped });
      } else {
        console.log(`Stopped session '${session}'`);
      }
    } catch (e) {
      if (jsonMode) {
        printJsonError(e instanceof Error ? e.message : String(e));
      } else {
        console.error(`Failed to stop session: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (cleanedArgs[0] === 'connect') {
    const cdpArg = cleanedArgs[1];
    const session = cleanedArgs[2] || defaultSession;

    if (!cdpArg) {
      if (jsonMode) {
        printJsonError('Missing CDP endpoint. Usage: claw-browser connect <port|url> [session]');
      } else {
        console.error('Missing CDP endpoint. Usage: claw-browser connect <port|url> [session]');
      }
      process.exit(1);
    }

    if (!isValidSessionName(session)) {
      if (jsonMode) {
        printJsonErrorWithType(
          `Invalid session name: ${session}`,
          'InvalidSessionName'
        );
      } else {
        console.error(`Invalid session name: ${session}`);
      }
      process.exit(1);
    }

    try {
      const cdpTarget = parseCdpTarget(cdpArg);
      const opts: connection.DaemonOptions = {
        headed: flags.headed || false,
        debug: process.env.CLAW_BROWSER_DEBUG === '1',
        cdp: cdpArg,
        profile: flags.profile,
      };

      const daemonResult = await connection.ensureDaemon(session, opts, VERSION);

      const launchResponse = await connection.sendCommand(
        {
          id: `connect-${Date.now()}`,
          action: 'launch',
          cdpTargetRaw: cdpArg,
          ...cdpTarget,
        },
        session
      );

      if (!launchResponse.success) {
        throw new Error(launchResponse.error || 'Failed to connect to CDP');
      }

      const launchData =
        launchResponse.data && typeof launchResponse.data === 'object'
          ? (launchResponse.data as {
              reused?: boolean;
              switchedFromManaged?: boolean;
              switchedExternalTarget?: boolean;
            })
          : undefined;
      const reused = Boolean(daemonResult.alreadyRunning || launchData?.reused);
      const switchedFromManaged = Boolean(launchData?.switchedFromManaged);
      const switchedExternalTarget = Boolean(launchData?.switchedExternalTarget);

      if (jsonMode) {
        printJsonValue({
          success: true,
          session,
          cdp: cdpArg,
          connected: true,
          reused,
          switchedFromManaged,
          switchedExternalTarget,
        });
      } else {
        if (switchedFromManaged) {
          console.log('Switched from managed browser to external CDP endpoint.');
        } else if (switchedExternalTarget) {
          console.log('Switched to requested external CDP endpoint.');
        }
        console.log('Done');
      }
    } catch (e) {
      if (jsonMode) {
        printJsonError(e instanceof Error ? e.message : String(e));
      } else {
        console.error(`Failed to connect: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (cleanedArgs[0] === 'session') {
    const sub = cleanedArgs[1];
    if (!sub) {
      if (jsonMode) {
        printJsonValue({ success: true, session: defaultSession });
      } else {
        console.log(defaultSession);
      }
      return;
    }
    if (sub === 'list') {
      const sessions = connection.listActiveSessions();
      if (jsonMode) {
        printJsonValue({ success: true, activeSessions: sessions, currentSession: defaultSession });
      } else {
        console.log('Active sessions:');
        for (const s of sessions) {
          const marker = s === defaultSession ? '->' : '  ';
          console.log(`${marker} ${s}`);
        }
      }
      return;
    }
    if (jsonMode) {
      printJsonError('Unknown session subcommand. Use: session [list]');
    } else {
      console.error('Unknown session subcommand. Use: session [list]');
    }
    process.exit(1);
  }

  if (cleanedArgs[0] === 'profiles') {
    const profiles = listChromeProfiles();
    if (jsonMode) {
      printJsonValue({ success: true, profiles });
    } else {
      if (profiles.length === 0) {
        console.log('No Chrome profiles found.');
      } else {
        for (const p of profiles) {
          console.log(`${p.dir}\t${p.name}`);
        }
      }
    }
    return;
  }

  // Detect if first arg is a session name or a command
  // If it's a valid command, use default session
  const possibleCommand = cleanedArgs[0];
  const isCommand = [
    'navigate', 'open', 'goto', 'back', 'forward', 'reload',
    'click', 'dblclick', 'focus', 'fill', 'type', 'setvalue', 'press', 'key', 'keyboard', 'keydown', 'keyup',
    'hover', 'select', 'check', 'uncheck', 'scroll', 'scrollintoview', 'scrollinto', 'drag', 'upload',
    'snapshot', 'screenshot', 'pdf', 'get', 'is', 'find', 'wait', 'mouse',
    'cookies', 'storage', 'network', 'set', 'route', 'unroute', 'console', 'errors',
    'tab', 'tabs', 'window', 'frame', 'dialog',
    'state', 'eval', 'evaluate', 'inspect', 'responsebody', 'bringtofront', 'highlight', 'selectall', 'clipboard', 'site', 'close', 'quit', 'exit',
    'session', 'profiles'
  ].includes(possibleCommand);

  let session: string;
  let commandArgs: string[];

  if (isCommand) {
    // Direct command mode: claw-browser open example.com
    session = defaultSession;
    commandArgs = cleanedArgs;
  } else {
    // Session mode: claw-browser my-session open example.com
    session = cleanedArgs[0];
    commandArgs = cleanedArgs.slice(1);

    if (!isValidSessionName(session)) {
      if (jsonMode) {
        printJsonErrorWithType(
          `Invalid session name: ${session}`,
          'InvalidSessionName'
        );
      } else {
        console.error(`Invalid session name: ${session}`);
      }
      process.exit(1);
    }

    if (commandArgs.length === 0) {
      if (jsonMode) {
        printJsonError('No command specified');
      } else {
        console.error('No command specified. Usage: claw-browser <session> <command> [args...]');
      }
      process.exit(1);
    }
  }

  try {
    if (commandArgs[0] === 'site') {
      const { runSiteCli } = await import('./cli/site.js');
      await runSiteCli(commandArgs.slice(1), {
        session,
        jsonMode,
        version: VERSION,
        daemonOptions: {
          headed: flags.headed || false,
          debug: false,
          cdp: flags.cdp,
          profile: flags.profile,
        },
        tabId: flags.tabId,
      });
      return;
    }

    const command = parseCommand(commandArgs, flags);

    // Ensure daemon is running
    const opts: connection.DaemonOptions = {
      headed: flags.headed || false,
      debug: false,
      cdp: flags.cdp,
      profile: flags.profile,
    };
    if (command.action === 'close_all') {
      const active = connection.listActiveSessions();
      const results: Array<{ session: string; success: boolean; error?: string }> = [];
      for (const s of active) {
        try {
          await stopSession(s);
          results.push({ session: s, success: true });
        } catch (err: any) {
          results.push({ session: s, success: false, error: err?.message || String(err) });
        }
      }
      if (jsonMode) {
        printJsonValue({ success: results.every((r) => r.success), data: { stopped: results } });
      } else {
        for (const r of results) {
          if (r.success) {
            console.log(`Stopped session '${r.session}'`);
          } else {
            console.error(`Failed to stop session '${r.session}': ${r.error}`);
          }
        }
      }
      return;
    }

    await connection.ensureDaemon(session, opts, VERSION);

    // Send command
    const response = await connection.sendCommand(command, session);

    if (jsonMode) {
      printJsonValue(response);
    } else {
      if (response.success) {
        printHumanSuccess(command, response);
      } else {
        console.error(`Error: ${response.error || 'Unknown error'}`);
        process.exit(1);
      }
    }
  } catch (e) {
    if (e instanceof InvalidSessionNameError) {
      if (jsonMode) {
        printJsonErrorWithType(e.message, 'InvalidSessionName');
      } else {
        console.error(e.message);
      }
      process.exit(1);
    }

    if (jsonMode) {
      printJsonError(e instanceof Error ? e.message : String(e));
    } else {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
claw-browser v${VERSION}
Fast browser automation CLI for AI agents (TypeScript port)

USAGE:
  claw-browser <command> [args...]                # Use default session
  claw-browser <session> <command> [args...]      # Use named session
  claw-browser --session <name> <command> [...]   # Use session via flag
  claw-browser start <session>                    # Start daemon session
  claw-browser stop <session>                     # Stop daemon session
  claw-browser connect <port|url> [session]       # Connect session to CDP
  claw-browser session [list]                     # Show current or list active sessions

COMMANDS:
  Navigation:
    navigate, open, goto <url>  Navigate to URL
    back                         Go back
    forward                      Go forward
    reload                       Reload page

  Interaction:
    click <selector>             Click element
    fill <selector> <text>       Fill input field
    type <selector> <text>       Type text into element
    hover <selector>             Hover over element

  Information:
    snapshot [options]           Get accessibility tree
    screenshot [selector]        Take screenshot
    eval, evaluate <script>      Evaluate JavaScript in current page
    get <field>                  Get text/html/value/attr/title/url/count/box/styles
    is <field> <selector>        visible/enabled/checked
    find <kind> <q> <action>     Find then act (click/fill/type/gettext/count)
    site <subcommand>            Manage and run site adapters
    console [--clear]            Show console messages
    errors [--clear]             Show runtime errors

  Tabs:
    tab                          List tabs (shows short id, tabId, and optional label)
    tab new [url]                Open a new tab (optionally navigate)
    tab new --label docs [url]   Open a new tab with a label
    tab <tN|label|tab-id>        Switch active tab
    tab close [tN|label|tab-id]  Close tab (default: active)
    window new                   Open a new window

  Session:
    start <session>              Start daemon session
    stop <session>               Stop daemon session
    connect <port|url> [session] Connect session to an existing Chrome CDP endpoint
    session                      Show current session
    session list                 List active sessions
    profiles                     List local Chrome profiles

  Misc:
    frame <selector>             Scope to iframe
    frame main                   Return to main frame
    dialog <status|accept|dismiss> Manage JS dialogs
    route <pattern>              Add request route
    unroute [pattern]            Remove route(s)
    network requests             Show tracked requests
    network request <id>         Show one request
    responsebody <id>            Get response body for request
    inspect                      Print current CDP endpoint
    highlight <selector>         Highlight an element
    clipboard <read|write>       Clipboard read/write
    help                         Show this help
    version                      Show version

EXAMPLES:
  # Direct commands (use default session)
  claw-browser open https://example.com
  claw-browser click "button[type='submit']"
  claw-browser snapshot
  claw-browser eval "location.href"
  claw-browser snapshot -i -u
  claw-browser snapshot -s "#main" -d 4
  claw-browser set media dark
  claw-browser set timezone Asia/Shanghai
  claw-browser set locale zh-CN
  claw-browser set geo 31.2304 121.4737
  claw-browser set content "<h1>Hello</h1>"
  claw-browser find text "Sign in" click
  claw-browser network requests --method GET
  claw-browser dialog status
  claw-browser site list
  claw-browser site xhs/note --note_id 123
  claw-browser tab list
  claw-browser tab new --label docs https://claw-browser.dev
  claw-browser tab t2
  claw-browser tab close docs
  claw-browser window new
  claw-browser --tab-id <tab-id> eval "document.title"
  claw-browser connect 9222
  claw-browser connect ws://127.0.0.1:9222/devtools/browser/abc123

  # Named session commands
  claw-browser start my-session
  claw-browser my-session navigate https://example.com
  claw-browser my-session click "button[type='submit']"
  claw-browser my-session snapshot
  claw-browser stop my-session

For more information, visit: https://claw-browser.dev
`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
