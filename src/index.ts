#!/usr/bin/env node

import { parseCommand, isValidSessionName } from './cli/commands.js';
import type { Flags } from './types/commands.js';
import { InvalidSessionNameError } from './types/commands.js';
import * as connection from './connection/index.js';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
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
      const tabId = typeof tab.id === 'string' ? tab.id : '';
      const title = typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : 'Untitled';
      const url = typeof tab.url === 'string' ? tab.url : '';
      console.log(`${marker} [${i}] ${tabId} ${title} - ${url}`);
    }
    return;
  }

  if (action === 'tab_new' || action === 'newTab' || action === 'tab_switch' || action === 'switchTab') {
    const tabId = typeof data.tabId === 'string' ? data.tabId : '';
    const title = typeof data.title === 'string' ? data.title : '';
    const url = typeof data.url === 'string' ? data.url : '';
    if (tabId || title || url) {
      if (title) {
        console.log(`✓ ${title}`);
      }
      if (url) {
        console.log(`  ${url}`);
      }
      if (tabId) {
        console.log(`  tab: ${tabId}`);
      }
      return;
    }
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

// Clean command-line arguments (remove flags)
function cleanArgs(args: string[]): string[] {
  const cleaned: string[] = [];
  let i = 0;

  // Flags that don't take a value (boolean flags)
  const booleanFlags = ['--headed', '--annotate'];

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      // Check if it's a boolean flag
      if (booleanFlags.includes(arg)) {
        i++;
        continue;
      }
      // Skip flag and its value if it has one
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        i += 2;
      } else {
        i++;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flag, skip it and its value
      i += 2;
    } else {
      cleaned.push(arg);
      i++;
    }
  }

  return cleaned;
}

// Parse CLI flags from arguments
function parseFlags(args: string[]): Flags {
  const flags: Flags = {};

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
    }
  }

  return flags;
}

async function main() {
  const args = process.argv.slice(2);

  // Check if we're running in daemon mode
  if (process.env.AGENT_BROWSER_DAEMON === '1') {
    console.error('[index] Daemon mode detected, starting daemon...');
    // Import and run daemon
    const { runDaemon } = await import('./daemon/index.js');
    const session = process.env.AGENT_BROWSER_SESSION || 'default';
    console.error(`[index] Calling runDaemon for session: ${session}`);
    await runDaemon({
      session,
      idleTimeoutMs: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS
        ? parseInt(process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS)
        : undefined,
      debug: process.env.AGENT_BROWSER_DEBUG === '1',
    });
    console.error('[index] runDaemon returned');
    return;
  }

  // Parse flags and clean args
  const flags = parseFlags(args);
  const cleanedArgs = cleanArgs(args);

  // JSON output mode
  const jsonMode = flags.cliAnnotate || process.env.AGENT_BROWSER_JSON === '1';

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
    const session = cleanedArgs[1] || 'default';

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
        debug: process.env.AGENT_BROWSER_DEBUG === '1',
      };

      // Parse proxy if provided
      if (flags.provider === 'proxy' && process.env.AGENT_BROWSER_PROXY) {
        const parsed = parseProxy(process.env.AGENT_BROWSER_PROXY);
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
    const session = cleanedArgs[1] || 'default';

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
      let gracefulStopped = false;

      // Try graceful shutdown first so browser processes can close cleanly.
      if (connection.daemonReady(session)) {
        try {
          const closeResponse = await connection.sendCommand(
            {
              id: `stop-${Date.now()}`,
              action: 'close',
            },
            session
          );
          gracefulStopped = Boolean(closeResponse.success);
        } catch {
          // Fall through to force-stop path.
        }
      }

      // If graceful close didn't work, force-stop daemon using PID fallback.
      if (!gracefulStopped) {
        await connection.forceStopDaemon(session);
      }

      // Always remove stale metadata files.
      connection.cleanupStaleFiles(session);

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
    const session = cleanedArgs[2] || 'default';

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
        debug: process.env.AGENT_BROWSER_DEBUG === '1',
        cdp: cdpArg,
      };

      const daemonResult = await connection.ensureDaemon(session, opts, VERSION);

      // Keep connect idempotent: if daemon is already running, do not force
      // another launch/reconnect cycle that may disrupt an active CDP session.
      if (daemonResult.alreadyRunning) {
        if (jsonMode) {
          printJsonValue({
            success: true,
            session,
            cdp: cdpArg,
            connected: true,
            reused: true,
          });
        } else {
          console.log('Done');
        }
        return;
      }

      const launchResponse = await connection.sendCommand(
        {
          id: `connect-${Date.now()}`,
          action: 'launch',
          ...cdpTarget,
        },
        session
      );

      if (!launchResponse.success) {
        throw new Error(launchResponse.error || 'Failed to connect to CDP');
      }

      if (jsonMode) {
        printJsonValue({
          success: true,
          session,
          cdp: cdpArg,
          connected: true,
        });
      } else {
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

  // Detect if first arg is a session name or a command
  // If it's a valid command, use default session
  const possibleCommand = cleanedArgs[0];
  const isCommand = ['navigate', 'open', 'goto', 'back', 'forward', 'reload',
                     'click', 'fill', 'type', 'hover', 'snapshot', 'screenshot',
                     'close', 'cookies', 'storage', 'network', 'tab', 'tabs',
                     'eval', 'evaluate', 'wait', 'scroll'].includes(possibleCommand);

  let session: string;
  let commandArgs: string[];

  if (isCommand) {
    // Direct command mode: claw-browser open example.com
    session = 'default';
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
    const command = parseCommand(commandArgs, flags);

    // Ensure daemon is running
    const opts: connection.DaemonOptions = {
      headed: flags.headed || false,
      debug: false,
      cdp: flags.cdp,
    };

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
  claw-browser start <session>                    # Start daemon session
  claw-browser stop <session>                     # Stop daemon session
  claw-browser connect <port|url> [session]       # Connect session to CDP

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
    snapshot                     Get accessibility tree
    screenshot [selector]        Take screenshot
    eval, evaluate <script>      Evaluate JavaScript in current page

  Tabs:
    tab [list]                   List tabs
    tab new [url]                Open a new tab (optionally navigate)
    tab switch <index|tab-id>    Switch active tab
    tab close [index|tab-id]     Close tab (default: active)

  Session:
    start <session>              Start daemon session
    stop <session>               Stop daemon session
    connect <port|url> [session] Connect session to an existing Chrome CDP endpoint

  Misc:
    help                         Show this help
    version                      Show version

EXAMPLES:
  # Direct commands (use default session)
  claw-browser open https://example.com
  claw-browser click "button[type='submit']"
  claw-browser snapshot
  claw-browser eval "location.href"
  claw-browser tab list
  claw-browser --tab-id <tab-id> eval "document.title"
  claw-browser connect 9222
  claw-browser connect ws://127.0.0.1:9222/devtools/browser/abc123

  # Named session commands
  claw-browser start my-session
  claw-browser my-session navigate https://example.com
  claw-browser my-session click "button[type='submit']"
  claw-browser my-session snapshot
  claw-browser stop my-session

For more information, visit: https://agent-browser.dev
`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
