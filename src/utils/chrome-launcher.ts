import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, rmSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
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
  tempUserDataDir?: string;
  kill: () => void;
  hasExited: () => boolean;
}

interface ChromeArgs {
  args: string[];
  userDataDir: string;
  tempUserDataDir?: string;
}

function buildChromeArgs(options: LaunchOptions): ChromeArgs {
  const args: string[] = [
    '--remote-debugging-port=0',
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
  let tempUserDataDir: string | undefined;

  if (options.profile) {
    // Expand tilde
    userDataDir = options.profile.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
  } else {
    // Create temp profile
    userDataDir = path.join(tmpdir(), `claw-browser-chrome-${randomUUID()}`);
    mkdirSync(userDataDir, { recursive: true });
    tempUserDataDir = userDataDir;
  }

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
    tempUserDataDir,
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

  const { args, userDataDir, tempUserDataDir } = buildChromeArgs(options);

  // Clean up stale DevToolsActivePort file
  const devToolsActivePortPath = path.join(userDataDir, 'DevToolsActivePort');
  try {
    unlinkSync(devToolsActivePortPath);
  } catch {
    // Ignore if file doesn't exist
  }

  const child = spawn(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const wsUrl = await waitForWsUrl(child, userDataDir, tempUserDataDir);

  const killFn = () => {
    try {
      child.kill('SIGTERM');
      // Give it a moment to exit gracefully
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000);
    } catch {
      // Ignore errors
    }

    // Clean up temp directory
    if (tempUserDataDir) {
      try {
        rmSync(tempUserDataDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Warning: failed to clean up temp profile ${tempUserDataDir}:`, err);
      }
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
    tempUserDataDir,
    kill: killFn,
    hasExited: hasExitedFn,
  };
}

/**
 * Wait for Chrome to write WebSocket URL to stderr or DevToolsActivePort file
 */
async function waitForWsUrl(
  child: ChildProcess,
  userDataDir: string,
  tempUserDataDir?: string
): Promise<string> {
  const deadline = Date.now() + 30000; // 30 second timeout

  // First try reading DevToolsActivePort file (more reliable on Windows)
  const devToolsPath = path.join(userDataDir, 'DevToolsActivePort');
  const pollInterval = 50;

  while (Date.now() < deadline) {
    // Check if process exited early
    if (child.exitCode !== null) {
      if (tempUserDataDir) {
        try {
          rmSync(tempUserDataDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
      throw new Error(`Chrome exited early with code ${child.exitCode}`);
    }

    // Try reading DevToolsActivePort
    try {
      const content = readFileSync(devToolsPath, 'utf-8');
      const lines = content.split('\n');
      if (lines.length >= 2) {
        const port = lines[0].trim();
        const wsPath = lines[1].trim();
        if (port && wsPath) {
          return `ws://127.0.0.1:${port}${wsPath}`;
        }
      }
    } catch {
      // File doesn't exist yet or not ready, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Fallback: try parsing stderr
  let stderrUrl: string | null = null;
  if (child.stderr) {
    child.stderr.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        stderrUrl = match[1];
      }
    });

    // Wait a bit for stderr
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (stderrUrl) {
    return stderrUrl;
  }

  // Timeout - kill and clean up
  child.kill();
  if (tempUserDataDir) {
    try {
      rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  throw new Error(
    'Timeout waiting for Chrome DevTools URL. Chrome may have failed to start or DevToolsActivePort was not written.'
  );
}
