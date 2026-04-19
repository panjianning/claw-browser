import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface Response {
  success: boolean;
  data?: unknown;
  error?: string;
  warning?: string;
}

export interface SessionMetadata {
  session: string;
  socketDir: string;
  transport: 'tcp' | 'unix';
  socketPath: string | null;
  port: number | null;
  pidPath: string;
  versionPath: string;
  pid: number | null;
  version: string | null;
}

export function listActiveSessions(): string[] {
  const dir = getSocketDir();
  let names: string[] = [];
  try {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir);
    names = files
      .filter((f) => f.endsWith('.pid'))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }

  // Keep deterministic output and only include sessions that still look active.
  return names
    .filter((name) => daemonReady(name))
    .sort((a, b) => a.localeCompare(b));
}

export function getSessionMetadata(session: string): SessionMetadata {
  const socketDir = getSocketDir();
  const pidPath = getPidPath(session);
  const versionPath = getVersionPath(session);

  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(pidPath, 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      pid = parsed;
    }
  } catch {}

  let version: string | null = null;
  try {
    const raw = fs.readFileSync(versionPath, 'utf-8').trim();
    if (raw.length > 0) {
      version = raw;
    }
  } catch {}

  if (process.platform === 'win32') {
    return {
      session,
      socketDir,
      transport: 'tcp',
      socketPath: null,
      port: resolvePort(session),
      pidPath,
      versionPath,
      pid,
      version,
    };
  }

  return {
    session,
    socketDir,
    transport: 'unix',
    socketPath: getSocketPath(session),
    port: null,
    pidPath,
    versionPath,
    pid,
    version,
  };
}

/**
 * Get the base directory for socket/port files.
 * Priority: CLAW_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.claw-browser > tmpdir
 */
export function getSocketDir(): string {
  // 1. Explicit override (ignore empty string)
  const envDir = process.env.CLAW_BROWSER_SOCKET_DIR;
  if (envDir && envDir.trim().length > 0) {
    return envDir;
  }

  // 2. XDG_RUNTIME_DIR (Linux standard, ignore empty string)
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir && xdgRuntimeDir.trim().length > 0) {
    return path.join(xdgRuntimeDir, 'claw-browser');
  }

  // 3. Home directory fallback (like Docker Desktop's ~/.docker/run/)
  const homeDir = os.homedir();
  if (homeDir) {
    return path.join(homeDir, '.claw-browser');
  }

  // 4. Last resort: temp dir
  return path.join(os.tmpdir(), 'claw-browser');
}

function getSocketPath(session: string): string {
  return path.join(getSocketDir(), `${session}.sock`);
}

function getPortPath(session: string): string {
  return path.join(getSocketDir(), `${session}.port`);
}

function getPidPath(session: string): string {
  return path.join(getSocketDir(), `${session}.pid`);
}

function getVersionPath(session: string): string {
  return path.join(getSocketDir(), `${session}.version`);
}

/**
 * Clean up stale socket and PID files for a session
 */
export function cleanupStaleFiles(session: string): void {
  const pidPath = getPidPath(session);
  const versionPath = getVersionPath(session);
  const streamPath = path.join(getSocketDir(), `${session}.stream`);

  try { fs.unlinkSync(pidPath); } catch {}
  try { fs.unlinkSync(versionPath); } catch {}
  try { fs.unlinkSync(streamPath); } catch {}

  if (process.platform !== 'win32') {
    const socketPath = getSocketPath(session);
    try { fs.unlinkSync(socketPath); } catch {}
  } else {
    const portPath = getPortPath(session);
    try { fs.unlinkSync(portPath); } catch {}
  }
}

/**
 * Get the port for a session on Windows (hash-based + port file override)
 */
function getPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = ((hash << 5) - hash + session.charCodeAt(i)) | 0;
  }
  return 49152 + (Math.abs(hash) % 16383);
}

/**
 * Read the actual daemon port from the .port file written by the daemon.
 * Falls back to the hash-derived port if the file doesn't exist.
 */
function resolvePort(session: string): number {
  const portPath = getPortPath(session);
  try {
    const portStr = fs.readFileSync(portPath, 'utf-8').trim();
    const port = parseInt(portStr, 10);
    if (!isNaN(port)) {
      return port;
    }
  } catch {}
  return getPortForSession(session);
}

/**
 * Check if daemon is ready to accept connections
 */
export function daemonReady(session: string): boolean {
  if (process.platform !== 'win32') {
    const socketPath = getSocketPath(session);
    try {
      // Check if socket file exists
      fs.accessSync(socketPath);
      return true;
    } catch {
      return false;
    }
  } else {
    const portPath = getPortPath(session);
    try {
      // Check if port file exists
      fs.accessSync(portPath);
      return true;
    } catch {
      return false;
    }
  }
}

async function daemonAcceptingConnections(session: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    if (process.platform !== 'win32') {
      const socketPath = getSocketPath(session);
      const socket = net.connect(socketPath);
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.end();
        done(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        done(false);
      });
      socket.once('error', () => {
        done(false);
      });
      return;
    }

    const port = resolvePort(session);
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.end();
      done(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/**
 * Check if the running daemon's version matches this CLI binary.
 */
function daemonVersionMatches(session: string, currentVersion: string): boolean {
  const versionPath = getVersionPath(session);
  try {
    const version = fs.readFileSync(versionPath, 'utf-8').trim();
    return version === currentVersion;
  } catch {
    return false;
  }
}

/**
 * Kill a running daemon by reading its PID file and sending a kill signal.
 */
async function killStaleDaemon(session: string): Promise<void> {
  // Remove the socket first so no new connections reach the old daemon
  if (process.platform !== 'win32') {
    const socketPath = getSocketPath(session);
    try { fs.unlinkSync(socketPath); } catch {}
  }

  const pidPath = getPidPath(session);
  try {
    const pidStr = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid)) {
      try {
        process.kill(pid, 'SIGTERM');

        // Wait up to 1s for graceful shutdown
        for (let i = 0; i < 10; i++) {
          await sleep(100);
          try {
            process.kill(pid, 0); // Check if process exists
          } catch {
            break; // Process is gone
          }
        }

        // Force-kill if still alive
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
          await sleep(100);
        } catch {}
      } catch {}
    }
  } catch {}

  // Clean up leftover files regardless
  cleanupStaleFiles(session);
}

export async function forceStopDaemon(session: string): Promise<void> {
  await killStaleDaemon(session);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DaemonResult {
  alreadyRunning: boolean;
}

export interface DaemonOptions {
  headed?: boolean;
  debug?: boolean;
  executablePath?: string;
  extensions?: string[];
  args?: string;
  userAgent?: string;
  proxy?: string;
  proxyBypass?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  ignoreHttpsErrors?: boolean;
  allowFileAccess?: boolean;
  profile?: string;
  state?: string;
  provider?: string;
  device?: string;
  sessionName?: string;
  downloadPath?: string;
  allowedDomains?: string[];
  actionPolicy?: string;
  confirmActions?: string;
  engine?: string;
  autoConnect?: boolean;
  idleTimeout?: string;
  defaultTimeout?: number;
  cdp?: string;
  noAutoDialog?: boolean;
}

function applyDaemonEnv(
  env: NodeJS.ProcessEnv,
  session: string,
  opts: DaemonOptions
): void {
  env.CLAW_BROWSER_DAEMON = '1';
  env.CLAW_BROWSER_SESSION = session;

  if (opts.headed) env.CLAW_BROWSER_HEADED = '1';
  if (opts.debug) env.CLAW_BROWSER_DEBUG = '1';
  if (opts.executablePath) env.CLAW_BROWSER_EXECUTABLE_PATH = opts.executablePath;
  if (opts.extensions && opts.extensions.length > 0) {
    env.CLAW_BROWSER_EXTENSIONS = opts.extensions.join(',');
  }
  if (opts.args) env.CLAW_BROWSER_ARGS = opts.args;
  if (opts.userAgent) env.CLAW_BROWSER_USER_AGENT = opts.userAgent;
  if (opts.proxy) env.CLAW_BROWSER_PROXY = opts.proxy;
  if (opts.proxyBypass) env.CLAW_BROWSER_PROXY_BYPASS = opts.proxyBypass;
  if (opts.proxyUsername) env.CLAW_BROWSER_PROXY_USERNAME = opts.proxyUsername;
  if (opts.proxyPassword) env.CLAW_BROWSER_PROXY_PASSWORD = opts.proxyPassword;
  if (opts.ignoreHttpsErrors) env.CLAW_BROWSER_IGNORE_HTTPS_ERRORS = '1';
  if (opts.allowFileAccess) env.CLAW_BROWSER_ALLOW_FILE_ACCESS = '1';
  if (opts.profile) env.CLAW_BROWSER_PROFILE = opts.profile;
  if (opts.state) env.CLAW_BROWSER_STATE = opts.state;
  if (opts.provider) env.CLAW_BROWSER_PROVIDER = opts.provider;
  if (opts.device) env.CLAW_BROWSER_IOS_DEVICE = opts.device;
  if (opts.sessionName) env.CLAW_BROWSER_SESSION_NAME = opts.sessionName;
  if (opts.downloadPath) env.CLAW_BROWSER_DOWNLOAD_PATH = opts.downloadPath;
  if (opts.allowedDomains && opts.allowedDomains.length > 0) {
    env.CLAW_BROWSER_ALLOWED_DOMAINS = opts.allowedDomains.join(',');
  }
  if (opts.actionPolicy) env.CLAW_BROWSER_ACTION_POLICY = opts.actionPolicy;
  if (opts.confirmActions) env.CLAW_BROWSER_CONFIRM_ACTIONS = opts.confirmActions;
  if (opts.engine) env.CLAW_BROWSER_ENGINE = opts.engine;
  if (opts.autoConnect) env.CLAW_BROWSER_AUTO_CONNECT = '1';
  if (opts.idleTimeout) env.CLAW_BROWSER_IDLE_TIMEOUT_MS = opts.idleTimeout;
  if (opts.defaultTimeout) env.CLAW_BROWSER_DEFAULT_TIMEOUT = opts.defaultTimeout.toString();
  if (opts.cdp) env.CLAW_BROWSER_CDP = opts.cdp;
  if (opts.noAutoDialog) env.CLAW_BROWSER_NO_AUTO_DIALOG = '1';
}

export async function ensureDaemon(
  session: string,
  opts: DaemonOptions,
  currentVersion: string
): Promise<DaemonResult> {
  // Socket/port file is only a hint; probe actual daemon responsiveness too.
  if (daemonReady(session)) {
    // Double-check daemon is actually accepting connections
    await sleep(150);
    if (daemonReady(session) && await daemonAcceptingConnections(session)) {
      // Check version: if mismatch, kill and restart
      if (!daemonVersionMatches(session, currentVersion)) {
        console.warn('Daemon version mismatch detected, restarting...');
        await killStaleDaemon(session);
        // Fall through to spawn new daemon
      } else {
        return { alreadyRunning: true };
      }
    } else {
      cleanupStaleFiles(session);
    }
  }

  // Clean up any stale files before starting fresh
  cleanupStaleFiles(session);

  // Ensure socket directory exists
  const socketDir = getSocketDir();
  if (!fs.existsSync(socketDir)) {
    try {
      fs.mkdirSync(socketDir, { recursive: true });
    } catch (e) {
      throw new Error(`Failed to create socket directory: ${e}`);
    }
  }

  // Pre-flight check: Validate socket path length (Unix limit is 104 bytes)
  if (process.platform !== 'win32') {
    const socketPath = getSocketPath(session);
    const pathLen = Buffer.byteLength(socketPath, 'utf8');
    if (pathLen > 103) {
      throw new Error(
        `Session name '${session}' is too long. Socket path would be ${pathLen} bytes (max 103).\n` +
        'Use a shorter session name or set CLAW_BROWSER_SOCKET_DIR to a shorter path.'
      );
    }
  }

  // Pre-flight check: Verify socket directory is writable
  try {
    const testFile = path.join(socketDir, '.write_test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
  } catch (e) {
    throw new Error(`Socket directory '${socketDir}' is not writable: ${e}`);
  }

  // Spawn daemon process
  const env = { ...process.env };
  applyDaemonEnv(env, session, opts);

  // The daemon script is in the same directory as this compiled file
  const daemonScript = path.join(__dirname, 'index.js');

  if (opts.debug) {
    console.error(`[connection] Spawning daemon: ${process.execPath} ${daemonScript}`);
    console.error(`[connection] With env: CLAW_BROWSER_DAEMON=1, SESSION=${session}`);
  }

  const daemonChild = spawn(process.execPath, [daemonScript], {
    env,
    detached: true,
    stdio: opts.debug ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'pipe'],
  });

  let stderrOutput = '';
  const onStderrData = (data: Buffer) => {
    stderrOutput += data.toString();
    // Keep only recent output to avoid unbounded growth.
    if (stderrOutput.length > 8192) {
      stderrOutput = stderrOutput.slice(-8192);
    }
  };

  if (!opts.debug && daemonChild.stderr) {
    // Collect stderr for non-debug mode error reporting.
    daemonChild.stderr.on('data', onStderrData);
  }

  const cleanupChildStdio = () => {
    if (!opts.debug && daemonChild.stderr) {
      daemonChild.stderr.off('data', onStderrData);
      daemonChild.stderr.destroy();
    }
  };

  daemonChild.unref();

  // Wait for daemon to be ready
  for (let i = 0; i < 50; i++) {
    if (daemonReady(session)) {
      cleanupChildStdio();
      return { alreadyRunning: false };
    }

    // Detect early daemon exit
    if (daemonChild.killed || daemonChild.exitCode !== null) {
      await sleep(100);
      const stderrTrimmed = stderrOutput.trim();

      // If daemon failed due to bind race, check if winner is accepting
      if (stderrTrimmed.includes('Address already in use') || stderrTrimmed.includes('Failed to bind')) {
        await sleep(200);
        if (daemonReady(session)) {
          cleanupChildStdio();
          return { alreadyRunning: true };
        }
      }

      cleanupChildStdio();
      if (stderrTrimmed.length > 0) {
        const msg = stderrTrimmed.length > 500 ? stderrTrimmed.slice(0, 500) : stderrTrimmed;
        throw new Error(`Daemon process exited during startup:\n${msg}`);
      }
      throw new Error('Daemon process exited during startup with no error output. Re-run with --debug for more details.');
    }

    await sleep(100);
  }

  cleanupChildStdio();
  const endpointInfo = process.platform !== 'win32'
    ? `socket: ${getSocketPath(session)}`
    : `port: 127.0.0.1:${resolvePort(session)}`;

  throw new Error(`Daemon failed to start (${endpointInfo})`);
}

/**
 * Connect to the daemon via IPC
 */
export async function connect(session: string): Promise<net.Socket> {
  if (process.platform !== 'win32') {
    const socketPath = getSocketPath(session);
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath, () => resolve(socket));
      socket.on('error', reject);
    });
  } else {
    const port = resolvePort(session);
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
      socket.on('error', reject);
    });
  }
}

/**
 * Check if an error is transient and worth retrying
 */
function isTransientError(error: string): boolean {
  return (
    error.includes('os error 35') || // EAGAIN on macOS
    error.includes('os error 11') || // EAGAIN on Linux
    error.includes('WouldBlock') ||
    error.includes('Resource temporarily unavailable') ||
    error.includes('EOF') ||
    error.includes('Unexpected end of JSON input') ||
    error.includes('Connection reset') ||
    error.includes('Broken pipe') ||
    error.includes('ECONNRESET') ||
    error.includes('EPIPE') ||
    error.includes('ENOENT') || // Socket gone
    error.includes('ECONNREFUSED') || // Connection refused
    error.includes('os error 54') || // Connection reset (macOS)
    error.includes('os error 104') || // Connection reset (Linux)
    error.includes('os error 2') || // No such file
    error.includes('os error 61') || // Connection refused (macOS)
    error.includes('os error 111') || // Connection refused (Linux)
    error.includes('os error 10061') || // Connection refused (Windows)
    error.includes('os error 10054') // Connection reset (Windows)
  );
}

async function sendCommandOnce(cmd: unknown, session: string): Promise<Response> {
  const socket = await connect(session);

  socket.setTimeout(30000); // 30s read timeout

  const jsonStr = JSON.stringify(cmd) + '\n';
  socket.write(jsonStr);

  return new Promise((resolve, reject) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const responseLine = buffer.slice(0, newlineIndex);
        try {
          const response = JSON.parse(responseLine) as Response;
          socket.end();
          resolve(response);
        } catch (e) {
          socket.end();
          reject(new Error(`Invalid response: ${e}`));
        }
      }
    });

    socket.on('error', (err) => {
      reject(new Error(`Failed to send: ${err.message}`));
    });

    socket.on('timeout', () => {
      socket.end();
      reject(new Error('Request timeout'));
    });

    socket.on('end', () => {
      if (buffer.trim().length === 0) {
        reject(new Error('Connection closed before response received'));
      }
    });
  });
}

export async function sendCommand(cmd: unknown, session: string): Promise<Response> {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 200;

  let lastError = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      return await sendCommandOnce(cmd, session);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);

      if (isTransientError(errorMsg)) {
        lastError = errorMsg;
        continue;
      }

      // Non-transient error, fail immediately
      throw new Error(errorMsg);
    }
  }

  throw new Error(
    `${lastError} (after ${MAX_RETRIES} retries - daemon may be busy or unresponsive)`
  );
}
