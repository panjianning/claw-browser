import { spawn, ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import net from 'net';
import path from 'path';
import { findChrome } from './chrome-finder.js';

export interface LaunchOptions {
  headless?: boolean;
  executablePath?: string;
  proxy?: string;
  proxyBypass?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  profile?: string;
  allowFileAccess?: boolean;
  args?: string[];
  extensions?: string[];
  storageState?: string;
  userAgent?: string;
  ignoreHTTPSErrors?: boolean;
  colorScheme?: string;
  downloadPath?: string;
  viewportSize?: { width: number; height: number };
  useRealKeychain?: boolean;
}

export interface ChromeProcess {
  process: ChildProcess;
  wsUrl: string;
  kill: () => void;
  hasExited: () => boolean;
}

interface ChromeArgs {
  args: string[];
  userDataDir: string;
  remoteDebuggingPort: number;
}

function resolveDefaultUserDataDir(): string {
  const rawSession = (process.env.CLAW_BROWSER_SESSION || 'default').trim();
  const session = rawSession.length > 0 ? rawSession : 'default';
  return path.join(homedir(), '.claw-browser', 'browser', session);
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate remote debugging port')));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function buildChromeArgs(options: LaunchOptions): Promise<ChromeArgs> {
  const remoteDebuggingPort = await findAvailablePort();
  const args: string[] = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-features=Translate',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--metrics-recording-only',
  ];

  if (!options.useRealKeychain) {
    args.push('--password-store=basic', '--use-mock-keychain');
  }

  const hasExtensions = options.extensions && options.extensions.length > 0;

  // Extensions require headed mode (content scripts not injected in headless)
  if (options.headless && !hasExtensions) {
    args.push('--headless=new');
    // Enable SwiftShader software rendering in headless mode
    args.push('--enable-unsafe-swiftshader');
  }

  if (options.proxy) {
    args.push(`--proxy-server=${options.proxy}`);
  }

  if (options.proxyBypass) {
    args.push(`--proxy-bypass-list=${options.proxyBypass}`);
  }

  let userDataDir: string;
  if (options.profile) {
    // Expand tilde
    userDataDir = options.profile.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
  } else {
    // Use a persistent default profile for better session continuity.
    userDataDir = resolveDefaultUserDataDir();
  }
  mkdirSync(userDataDir, { recursive: true });

  args.push(`--user-data-dir=${userDataDir}`);

  if (options.ignoreHTTPSErrors) {
    args.push('--ignore-certificate-errors');
  }

  if (options.allowFileAccess) {
    args.push('--allow-file-access-from-files', '--allow-file-access');
  }

  if (hasExtensions) {
    const extList = options.extensions!.join(',');
    args.push(`--load-extension=${extList}`, `--disable-extensions-except=${extList}`);
  }

  // Window size
  const hasWindowSize =
    options.args?.some(
      (a) => a.startsWith('--start-maximized') || a.startsWith('--window-size=')
    ) ?? false;

  if (!hasWindowSize && options.headless && !hasExtensions) {
    const { width = 1280, height = 720 } = options.viewportSize || {};
    args.push(`--window-size=${width},${height}`);
  }

  if (options.args) {
    args.push(...options.args);
  }

  // Add --no-sandbox if not already present and running in certain environments
  if (shouldDisableSandbox(args)) {
    args.push('--no-sandbox');
  }

  if (shouldDisableDevShm(args)) {
    args.push('--disable-dev-shm-usage');
  }

  return {
    args,
    userDataDir,
    remoteDebuggingPort,
  };
}

function shouldDisableSandbox(args: string[]): boolean {
  if (args.some((a) => a === '--no-sandbox')) {
    return false; // Already present
  }

  // Check if running in container or as root
  if (process.getuid && process.getuid() === 0) {
    return true;
  }

  // Check for container environment
  const isContainer =
    process.env.KUBERNETES_SERVICE_HOST ||
    process.env.container ||
    process.env.DOCKER_CONTAINER;

  return !!isContainer;
}

function shouldDisableDevShm(args: string[]): boolean {
  if (args.some((a) => a === '--disable-dev-shm-usage')) {
    return false; // Already present
  }

  // Enable in container environments where /dev/shm is small
  return !!process.env.DOCKER_CONTAINER;
}

/**
 * Launch Chrome and return process handle + WebSocket URL
 */
export async function launchChrome(options: LaunchOptions = {}): Promise<ChromeProcess> {
  const chromePath = options.executablePath || findChrome();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Install Chrome or use executablePath option to specify the Chrome binary path.'
    );
  }

  const { args, remoteDebuggingPort } = await buildChromeArgs(options);

  const child = spawn(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const wsUrl = await waitForWsUrl(child, remoteDebuggingPort);

  const killFn = () => {
    try {
      child.kill('SIGTERM');
      // Give it a moment to exit gracefully
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 1000);
    } catch {
      // Ignore errors
    }

  };

  const hasExitedFn = () => {
    return child.exitCode !== null || child.killed;
  };

  // Ensure cleanup on exit
  process.on('exit', killFn);

  return {
    process: child,
    wsUrl,
    kill: killFn,
    hasExited: hasExitedFn,
  };
}

/**
 * Wait for Chrome DevTools endpoint via /json/version.
 */
async function waitForWsUrl(child: ChildProcess, remoteDebuggingPort: number): Promise<string> {
  const deadline = Date.now() + 30000; // 30 second timeout
  const versionUrl = `http://127.0.0.1:${remoteDebuggingPort}/json/version`;
  const pollInterval = 50;

  while (Date.now() < deadline) {
    // Check if process exited early
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.webSocketDebuggerUrl && typeof payload.webSocketDebuggerUrl === 'string') {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Endpoint not available yet, continue polling.
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout - kill and clean up
  child.kill();
  throw new Error(
    `Timeout waiting for Chrome DevTools URL from ${versionUrl}. ` +
    'Chrome may have failed to start or /json/version was not ready in time.'
  );
}
