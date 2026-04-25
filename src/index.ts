#!/usr/bin/env node

import { parseCommand, isValidSessionName } from './cli/commands.js';
import {
  GLOBAL_FLAG_DEFS,
  HELP_CATALOG,
  HELP_EXAMPLES,
  HELP_OVERVIEW_SECTIONS,
  HELP_USAGE_LINES,
  type HelpTopic,
} from './cli/help-schema.js';
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

interface SessionStatusSummary {
  session: string;
  reachable: boolean;
  mode: string;
  backendType?: string;
  engine?: string;
  headed: boolean | null;
  cdpConnected: boolean;
  externalTarget: string | null;
  cdpUrl: string | null;
  profile: string | null;
  daemonPid: number | null;
  startedAt: string | null;
  uptimeMs: number | null;
  socketDir: string;
  transport: 'tcp' | 'unix';
  socketPath: string | null;
  port: number | null;
  pidPath: string;
  versionPath: string;
  daemonVersion: string | null;
  pidFromFile: number | null;
  error?: string;
}

function shortCdpEndpoint(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === 'wss:' ? '443' : '80')}`;
  } catch {
    return url;
  }
}

function parseSessionStatusData(session: string, data: any): SessionStatusSummary {
  const meta = connection.getSessionMetadata(session);
  const mode = typeof data?.mode === 'string' ? data.mode : 'unknown';
  const backendType = typeof data?.backendType === 'string' ? data.backendType : undefined;
  const engine = typeof data?.engine === 'string' ? data.engine : undefined;
  const headed = typeof data?.headed === 'boolean' ? data.headed : null;
  const cdpConnected = data?.cdpConnected === true;
  const externalTarget =
    typeof data?.externalTarget === 'string' && data.externalTarget.trim().length > 0
      ? data.externalTarget.trim()
      : null;
  const cdpUrl =
    typeof data?.cdpUrl === 'string' && data.cdpUrl.trim().length > 0
      ? data.cdpUrl.trim()
      : null;
  const profile =
    typeof data?.profile === 'string' && data.profile.trim().length > 0
      ? data.profile.trim()
      : null;
  const daemonPid = typeof data?.daemonPid === 'number' ? data.daemonPid : null;
  const startedAt =
    typeof data?.startedAt === 'string' && data.startedAt.trim().length > 0
      ? data.startedAt.trim()
      : null;
  const uptimeMs = typeof data?.uptimeMs === 'number' ? data.uptimeMs : null;

  return {
    session,
    reachable: true,
    mode,
    backendType,
    engine,
    headed,
    cdpConnected,
    externalTarget,
    cdpUrl,
    profile,
    daemonPid,
    startedAt,
    uptimeMs,
    socketDir: meta.socketDir,
    transport: meta.transport,
    socketPath: meta.socketPath,
    port: meta.port,
    pidPath: meta.pidPath,
    versionPath: meta.versionPath,
    daemonVersion: meta.version,
    pidFromFile: meta.pid,
  };
}

async function collectSessionStatus(session: string): Promise<SessionStatusSummary> {
  const meta = connection.getSessionMetadata(session);
  try {
    const res = await connection.sendCommand(
      { id: `session-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action: 'session_status' },
      session
    );
    if (!res.success) {
      return {
        session,
        reachable: false,
        mode: 'unreachable',
        headed: null,
        cdpConnected: false,
        externalTarget: null,
        cdpUrl: null,
        profile: null,
        daemonPid: meta.pid,
        startedAt: null,
        uptimeMs: null,
        socketDir: meta.socketDir,
        transport: meta.transport,
        socketPath: meta.socketPath,
        port: meta.port,
        pidPath: meta.pidPath,
        versionPath: meta.versionPath,
        daemonVersion: meta.version,
        pidFromFile: meta.pid,
        error: res.error || 'status request failed',
      };
    }
    return parseSessionStatusData(session, res.data);
  } catch (e) {
    return {
      session,
      reachable: false,
      mode: 'unreachable',
      headed: null,
      cdpConnected: false,
      externalTarget: null,
      cdpUrl: null,
      profile: null,
      daemonPid: meta.pid,
      startedAt: null,
      uptimeMs: null,
      socketDir: meta.socketDir,
      transport: meta.transport,
      socketPath: meta.socketPath,
      port: meta.port,
      pidPath: meta.pidPath,
      versionPath: meta.versionPath,
      daemonVersion: meta.version,
      pidFromFile: meta.pid,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
      const label = typeof tab.label === 'string' && tab.label.length > 0 ? tab.label : '';
      const title = typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : 'Untitled';
      const url = typeof tab.url === 'string' ? tab.url : '';
      const labelPart = label ? ` [${label}]` : '';
      console.log(`${marker}${labelPart} ${tabId} ${title} - ${url}`);
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
      if (label) {
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
  const globalFlagMap = new Map(
    GLOBAL_FLAG_DEFS.flatMap((def) => def.names.map((name) => [name, def] as const))
  );

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const def = globalFlagMap.get(arg);
    if (!def) {
      cleanedArgs.push(arg);
      continue;
    }

    if (def.kind === 'boolean') {
      (flags as any)[def.field] = true;
      continue;
    }

    const value = args[i + 1];
    i++;
    if (def.kind === 'number') {
      (flags as any)[def.field] = parseInt(value, 10);
    } else {
      (flags as any)[def.field] = value;
    }
  }

  return { flags, cleanedArgs };
}

function resolveDaemonHeaded(flags: Flags): boolean {
  if (flags.headless) {
    return false;
  }
  if (flags.headed) {
    return true;
  }
  return true;
}

const HELP_FLAGS = new Set(['--help', '-h', '-help']);

function stripHelpFlags(args: string[]): string[] {
  return args.filter((arg) => !HELP_FLAGS.has(arg));
}

function hasHelpFlag(args: string[]): boolean {
  return args.some((arg) => HELP_FLAGS.has(arg));
}

function printHelpTopic(topic: HelpTopic): void {
  console.log(`Usage: ${topic.usage}`);
  if (topic.description) {
    console.log(topic.description);
  }
  if (topic.subcommands) {
    const subs = Object.keys(topic.subcommands).sort((a, b) => a.localeCompare(b));
    if (subs.length > 0) {
      console.log(`Subcommands: ${subs.join(', ')}`);
    }
  }
}

function printCommandHelp(args: string[]): boolean {
  if (!hasHelpFlag(args)) return false;

  const tokens = stripHelpFlags(args);
  if (tokens.length === 0) {
    printHelp();
    return true;
  }

  const cmd = tokens[0].toLowerCase();
  const sub = (tokens[1] || '').toLowerCase();
  const topic = HELP_CATALOG[cmd];
  if (!topic) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  if (sub && topic.subcommands?.[sub]) {
    printHelpTopic(topic.subcommands[sub]);
    return true;
  }

  if ((cmd === 'tab' || cmd === 'tabs') && sub) {
    printHelpTopic(HELP_CATALOG.tab.subcommands!.switch);
    console.log(`Example: claw-browser tab switch ${sub}`);
    return true;
  }

  printHelpTopic(topic);

  return true;
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

  // Keep site-specific help dispatch in runSiteCli so adapter help still works:
  // claw-browser site <adapter> --help
  if (cleanedArgs[0] !== 'site') {
    try {
      if (printCommandHelp(cleanedArgs)) {
        return;
      }
    } catch (e) {
      if (jsonMode) {
        printJsonError(e instanceof Error ? e.message : String(e));
      } else {
        console.error(e instanceof Error ? e.message : String(e));
      }
      process.exitCode=1;return;
    }
  }

  if (cleanedArgs[0] === 'version' || cleanedArgs[0] === '--version' || cleanedArgs[0] === '-v') {
    if (jsonMode) {
      printJsonValue({ success: true, version: VERSION });
    } else {
      console.log(`claw-browser v${VERSION}`);
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
      process.exitCode=1;return;
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
      process.exitCode=1;return;
    }

    try {
      const cdpTarget = parseCdpTarget(cdpArg);
      const opts: connection.DaemonOptions = {
        headed: resolveDaemonHeaded(flags),
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
      process.exitCode=1;return;
    }
    return;
  }

  if (cleanedArgs[0] === 'session') {
    const sub = cleanedArgs[1];
    if (sub === 'list') {
      const sessions = connection.listActiveSessions();
      const sessionStatuses = await Promise.all(
        sessions.map((s) => collectSessionStatus(s))
      );
      if (jsonMode) {
        printJsonValue({
          success: true,
          activeSessions: sessions,
          currentSession: defaultSession,
          sessions: sessionStatuses,
        });
      } else {
        console.log('Active sessions:');
        for (const st of sessionStatuses) {
          const marker = st.session === defaultSession ? '->' : '  ';
          const mode = st.mode || 'unknown';
          const headedText =
            st.headed === null ? 'unknown' : (st.headed ? 'headed' : 'headless');
          const cdpText = st.cdpConnected ? 'up' : 'down';
          const endpoint = shortCdpEndpoint(st.cdpUrl);
          const target = st.externalTarget ? ` target=${st.externalTarget}` : '';
          const endpointText = endpoint ? ` cdp=${endpoint}` : '';
          const engineText = st.engine ? ` engine=${st.engine}` : '';
          const profileText = st.profile ? ` profile=${st.profile}` : '';
          const pidText = st.daemonPid ? ` pid=${st.daemonPid}` : '';
          const versionText = st.daemonVersion ? ` ver=${st.daemonVersion}` : '';
          const transportText = st.transport === 'tcp'
            ? ` transport=tcp:${st.port ?? 'n/a'}`
            : ` transport=unix`;
          const uptimeText =
            typeof st.uptimeMs === 'number' ? ` uptime=${Math.floor(st.uptimeMs / 1000)}s` : '';
          const err = st.error ? ` error=${st.error}` : '';
          console.log(
            `${marker} ${st.session} [${mode}] ${headedText} cdp:${cdpText}${engineText}${profileText}${pidText}${versionText}${transportText}${endpointText}${target}${uptimeText}${err}`
          );
          const startedAtText = st.startedAt ? st.startedAt : 'unknown';
          const socketText = st.socketPath ? st.socketPath : '-';
          console.log(`   startedAt=${startedAtText} socketDir=${st.socketDir}`);
          console.log(`   pidFile=${st.pidPath} versionFile=${st.versionPath} socket=${socketText}`);
        }
      }
      return;
    }
    if (sub === 'start') {
      const session = cleanedArgs[2] || defaultSession;

      if (!isValidSessionName(session)) {
        if (jsonMode) {
          printJsonErrorWithType(
            `Invalid session name: ${session}. Session names must not contain path separators or invalid characters`,
            'InvalidSessionName'
          );
        } else {
          console.error(`Invalid session name: ${session}`);
        }
        process.exitCode=1;return;
      }

      try {
        const opts: connection.DaemonOptions = {
          headed: resolveDaemonHeaded(flags),
          debug: process.env.CLAW_BROWSER_DEBUG === '1',
          profile: flags.profile,
        };

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
        process.exitCode=1;return;
      }
      return;
    }
    if (sub === 'stop') {
      const session = cleanedArgs[2] || defaultSession;

      if (!isValidSessionName(session)) {
        if (jsonMode) {
          printJsonErrorWithType(
            `Invalid session name: ${session}`,
            'InvalidSessionName'
          );
        } else {
          console.error(`Invalid session name: ${session}`);
        }
        process.exitCode=1;return;
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
        process.exitCode=1;return;
      }
      return;
    }
    if (sub === 'stop-all') {
      try {
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
      } catch (e) {
        if (jsonMode) {
          printJsonError(e instanceof Error ? e.message : String(e));
        } else {
          console.error(`Failed to stop sessions: ${e instanceof Error ? e.message : String(e)}`);
        }
        process.exitCode=1;return;
      }
      return;
    }
    if (!sub) {
      if (jsonMode) {
        printJsonError('Missing session subcommand. Use: session <start|stop|stop-all|list>');
      } else {
        console.error('Missing session subcommand. Use: session <start|stop|stop-all|list>');
      }
      process.exitCode=1;return;
    }
    if (jsonMode) {
      printJsonError('Unknown session subcommand. Use: session <start|stop|stop-all|list>');
    } else {
      console.error('Unknown session subcommand. Use: session <start|stop|stop-all|list>');
    }
    process.exitCode=1;return;
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

  const session = defaultSession;
  const commandArgs = cleanedArgs;

  try {
    if (commandArgs[0] === 'site') {
      const { runSiteCli } = await import('./cli/site.js');
      await runSiteCli(commandArgs.slice(1), {
        session,
        jsonMode,
        version: VERSION,
        daemonOptions: {
          headed: resolveDaemonHeaded(flags),
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
      headed: resolveDaemonHeaded(flags),
      debug: false,
      cdp: flags.cdp,
      profile: flags.profile,
    };
    const daemonResult = await connection.ensureDaemon(session, opts, VERSION);
    if (!jsonMode && !daemonResult.alreadyRunning) {
      const mode = opts.headed ? 'headed' : 'headless';
      console.log(`Session '${session}': daemon started (${mode}).`);
      console.log(`Session '${session}': command channel connected.`);
    }

    // Send command
    const response = await connection.sendCommand(command, session);

    if (jsonMode) {
      printJsonValue(response);
    } else {
      if (response.success) {
        if (typeof response.warning === 'string' && response.warning.trim().length > 0) {
          console.log(`Warning: ${response.warning}`);
        }
        printHumanSuccess(command, response);
      } else {
        console.error(`Error: ${response.error || 'Unknown error'}`);
        process.exitCode=1;return;
      }
    }
  } catch (e) {
    if (e instanceof InvalidSessionNameError) {
      if (jsonMode) {
        printJsonErrorWithType(e.message, 'InvalidSessionName');
      } else {
        console.error(e.message);
      }
      process.exitCode=1;return;
    }

    if (jsonMode) {
      printJsonError(e instanceof Error ? e.message : String(e));
    } else {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exitCode=1;return;
  }
}

function printHelp(): void {
  const globalFlagsText = GLOBAL_FLAG_DEFS
    .map((def) => {
      const [primary, ...aliases] = def.names;
      const label = def.kind === 'boolean' ? primary : `${primary} <value>`;
      const aliasText = aliases.length > 0 ? ` (alias: ${aliases.join(', ')})` : '';
      return `  ${label.padEnd(28, ' ')} ${def.description}${aliasText}`;
    })
    .join('\n');

  const usageText = HELP_USAGE_LINES.map((line) => `  ${line}`).join('\n');
  const commandSectionsText = HELP_OVERVIEW_SECTIONS
    .map((section) => {
      const items = section.items
        .map((item) => `    ${item.command.padEnd(28, ' ')} ${item.summary}`)
        .join('\n');
      return `  ${section.title}:\n${items}`;
    })
    .join('\n\n');
  const directExamples = HELP_EXAMPLES.direct.map((line) => `  ${line}`).join('\n');
  const sessionExamples = HELP_EXAMPLES.session.map((line) => `  ${line}`).join('\n');

  console.log([
    `claw-browser v${VERSION}`,
    'Fast browser automation CLI for AI agents (TypeScript port)',
    '',
    'USAGE:',
    usageText,
    '',
    'GLOBAL OPTIONS:',
    globalFlagsText,
    '',
    'COMMANDS:',
    commandSectionsText,
    '',
    'EXAMPLES:',
    '  # Direct commands (use default session)',
    directExamples,
    '',
    '  # Named session commands',
    sessionExamples,
    '',
    'For more information, visit: https://claw-browser.dev',
  ].join('\n'));
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
