import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DaemonState } from '../browser/state.js';
import { executeCommand } from '../browser/executor.js';

/**
 * Daemon process - long-running background process per session
 * Translate from cli/src/native/daemon.rs
 */

export interface DaemonOptions {
  session: string;
  preferredPort?: number;
  idleTimeoutMs?: number;
  debug?: boolean;
}

function getSocketDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(homeDir, '.agent-browser');
}

function getPortForSession(session: string): number {
  // Hash session name to port in range 40000-65000
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = ((hash << 5) - hash) + session.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return 40000 + (Math.abs(hash) % 25000);
}

/**
 * Run daemon process for a session
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { session, preferredPort, idleTimeoutMs, debug } = options;

  try {
    if (debug) console.error(`[daemon] Starting daemon for session: ${session}`);

    const socketDir = getSocketDir();
    await fs.mkdir(socketDir, { recursive: true });
    if (debug) console.error(`[daemon] Socket dir: ${socketDir}`);

  // Write PID file
  const pidPath = path.join(socketDir, `${session}.pid`);
  await fs.writeFile(pidPath, String(process.pid));

  // Write version file
  const versionPath = path.join(socketDir, `${session}.version`);
  try {
    const pkg = await import('../../package.json', { assert: { type: 'json' } });
    const version = pkg.default?.version || '0.1.0';
    await fs.writeFile(versionPath, version);
    if (debug) console.error(`[daemon] Session ${session} version: ${version}`);
  } catch (e) {
    // Fall back to default version if package.json can't be imported
    await fs.writeFile(versionPath, '0.1.0');
    if (debug) console.error('[daemon] Using fallback version 0.1.0');
  }

  // Create daemon state
  const state = new DaemonState();
  state.sessionName = session;

  // Start IPC server
  let server: net.Server;
  let activePort: number | undefined;

  if (process.platform === 'win32') {
    // Windows: Use TCP server
    const port = preferredPort || getPortForSession(session);
    server = await startTcpServer(state, port, session);
    activePort = (server.address() as net.AddressInfo)?.port;

    // Write port file
    const portPath = path.join(socketDir, `${session}.port`);
    await fs.writeFile(portPath, String(activePort));
  } else {
    // Unix: Use Unix domain socket
    const socketPath = path.join(socketDir, `${session}.sock`);

    // Remove stale socket
    try {
      await fs.unlink(socketPath);
    } catch (e) {
      // Ignore if doesn't exist
    }

    server = await startUnixServer(state, socketPath);
  }

  // Setup cleanup handlers
  const cleanup = async () => {
    // Close browser if running
    if (state.browser) {
      try {
        await state.browser.close();
      } catch (e) {
        console.error('Failed to close browser:', e);
      }
    }

    // Stop background tasks
    state.stopFetchHandler();
    state.stopDialogHandler();

    // Close server
    server.close();

    // Remove session files
    try {
      await fs.unlink(pidPath);
      await fs.unlink(versionPath);

      if (process.platform === 'win32') {
        const portPath = path.join(socketDir, `${session}.port`);
        await fs.unlink(portPath);
      } else {
        const socketPath = path.join(socketDir, `${session}.sock`);
        await fs.unlink(socketPath);
      }

      // Clean up other session files
      const streamPath = path.join(socketDir, `${session}.stream`);
      const enginePath = path.join(socketDir, `${session}.engine`);
      const providerPath = path.join(socketDir, `${session}.provider`);
      const extensionsPath = path.join(socketDir, `${session}.extensions`);
      await Promise.all([
        fs.unlink(streamPath).catch(() => {}),
        fs.unlink(enginePath).catch(() => {}),
        fs.unlink(providerPath).catch(() => {}),
        fs.unlink(extensionsPath).catch(() => {}),
      ]);
    } catch (e) {
      // Ignore cleanup errors
    }

    process.exit(0);
  };

  // Handle shutdown signals
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  // Idle timeout (auto-shutdown after inactivity)
  let idleTimer: NodeJS.Timeout | null = null;
  let lastActivityTime = Date.now();

  const resetIdleTimer = () => {
    lastActivityTime = Date.now();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleTimeoutMs && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        console.error(`Daemon idle timeout reached (${idleTimeoutMs}ms), shutting down`);
        cleanup();
      }, idleTimeoutMs);
    }
  };

  resetIdleTimer();

  // CDP event draining loop
  const drainInterval = setInterval(async () => {
    if (state.browser) {
      try {
        // Check if browser process exited
        // TODO: Implement has_process_exited() check
        // For now, just drain events
        await state.drainCdpEventsBackground();
      } catch (e) {
        console.error('Failed to drain CDP events:', e);
      }
    }
  }, 100);

  if (debug) console.error('[daemon] Daemon started successfully, keeping alive...');

  // Keep process alive indefinitely
  await new Promise((resolve) => {
    // Never resolve - server will keep the process running until signals
  });
  } catch (error: any) {
    console.error(`[daemon] Fatal error: ${error.message || error}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function startTcpServer(
  state: DaemonState,
  preferredPort: number,
  session: string
): Promise<net.Server> {
  const executeSerialized = createSerializedExecutor(state);

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleConnection(socket, executeSerialized);
    });

    // Try preferred port first
    server.listen(preferredPort, '127.0.0.1', () => {
      if (process.env.AGENT_BROWSER_DEBUG) {
        console.error(`[daemon] TCP server listening on 127.0.0.1:${preferredPort}`);
      }
      resolve(server);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        if (process.env.AGENT_BROWSER_DEBUG) {
          console.error(`[daemon] Port ${preferredPort} in use, trying ephemeral port`);
        }
        // Port in use, try ephemeral port
        server.listen(0, '127.0.0.1', () => {
          const actualPort = (server.address() as net.AddressInfo)?.port;
          if (process.env.AGENT_BROWSER_DEBUG) {
            console.error(`[daemon] TCP server listening on 127.0.0.1:${actualPort}`);
          }
          resolve(server);
        });
      } else {
        reject(err);
      }
    });
  });
}

async function startUnixServer(
  state: DaemonState,
  socketPath: string
): Promise<net.Server> {
  const executeSerialized = createSerializedExecutor(state);

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleConnection(socket, executeSerialized);
    });

    server.listen(socketPath, () => {
      resolve(server);
    });

    server.on('error', reject);
  });
}

/**
 * Handle incoming IPC connection
 */
async function handleConnection(
  socket: net.Socket,
  executeSerialized: (cmd: any) => Promise<any>
): Promise<void> {
  let buffer = '';

  socket.on('data', async (data) => {
    buffer += data.toString('utf-8');

    // Process complete JSON messages (newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, newlineIndex);
      buffer = buffer.substring(newlineIndex + 1);

      if (line.trim().length === 0) continue;

      try {
        const cmd = JSON.parse(line);
        const result = await executeSerialized(cmd);
        socket.write(JSON.stringify(result) + '\n');

        // Handle close command
        if (cmd.action === 'close' && result.success) {
          socket.end();
          // Exit daemon after a short delay to allow response to be sent
          setTimeout(() => {
            process.exit(0);
          }, 100);
        }
      } catch (error: any) {
        const errorResult = {
          id: '',
          success: false,
          error: `Failed to process command: ${error.message || String(error)}`,
        };
        socket.write(JSON.stringify(errorResult) + '\n');
      }
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });

  socket.on('end', () => {
    // Connection closed
  });
}

/**
 * Serialize command execution across all IPC connections.
 * This mirrors the Rust daemon behavior where a single state mutex
 * ensures commands execute one-by-one.
 */
function createSerializedExecutor(
  state: DaemonState
): (cmd: any) => Promise<any> {
  let tail: Promise<void> = Promise.resolve();

  return async (cmd: any): Promise<any> => {
    const previous = tail;
    let release!: () => void;

    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await executeCommand(cmd, state);
    } finally {
      release();
    }
  };
}
