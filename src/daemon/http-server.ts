import * as net from 'net';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DaemonState } from '../browser/state.js';

/**
 * HTTP server for dashboard UI and API endpoints
 * Translate from cli/src/native/stream/http.rs
 */

interface ApiEndpoint {
  method: string;
  path: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, state: DaemonState) => Promise<void>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Start HTTP server for dashboard and API
 */
export async function startHttpServer(
  state: DaemonState,
  port?: number
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, state);
    } catch (error: any) {
      console.error('[http] Request error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ success: false, error: error.message || String(error) }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    const listenPort = port || 0; // 0 = ephemeral port
    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      console.log(`[http] Dashboard server listening on http://127.0.0.1:${actualPort}`);
      resolve(server);
    });

    server.on('error', reject);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: DaemonState
): Promise<void> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  // OPTIONS requests for CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
      'Content-Length': '0',
    });
    res.end();
    return;
  }

  // API endpoints
  if (url.startsWith('/api/')) {
    await handleApiRequest(method, url, req, res, state);
    return;
  }

  // Dashboard static files
  await serveDashboard(url, res);
}

async function handleApiRequest(
  method: string,
  url: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: DaemonState
): Promise<void> {
  // GET /api/tabs - List all tabs
  if (method === 'GET' && url === '/api/tabs') {
    const mgr = state.browser;
    if (!mgr) {
      sendJson(res, 200, []);
      return;
    }

    try {
      const targets = await mgr.client.sendCommand('Target.getTargets', {});
      const tabs = (targets.targetInfos || [])
        .filter((t: any) => t.type === 'page')
        .map((t: any) => ({
          targetId: t.targetId,
          title: t.title,
          url: t.url,
          attached: t.attached,
        }));
      sendJson(res, 200, tabs);
    } catch (error: any) {
      sendJson(res, 500, { success: false, error: error.message });
    }
    return;
  }

  // GET /api/status - Daemon status
  if (method === 'GET' && url === '/api/status') {
    const status = {
      session: state.sessionName,
      browserRunning: state.browser !== null,
      activeFrameId: state.activeFrameId,
      refMapSize: state.refMap.size,
    };
    sendJson(res, 200, status);
    return;
  }

  // GET /api/sessions - List all sessions
  if (method === 'GET' && url === '/api/sessions') {
    const sessions = await discoverSessions();
    sendJson(res, 200, sessions);
    return;
  }

  // POST /api/sessions - Create new session
  if (method === 'POST' && url === '/api/sessions') {
    const body = await readBody(req, 10 * 1024); // 10KB limit
    if (!body) {
      sendJson(res, 413, { success: false, error: 'Request body too large' });
      return;
    }

    try {
      const data = JSON.parse(body);
      const sessionName = data.session || data.name;
      if (!sessionName) {
        sendJson(res, 400, { success: false, error: 'Missing session name' });
        return;
      }

      // TODO: Spawn new daemon process
      sendJson(res, 200, { success: true, session: sessionName });
    } catch (error: any) {
      sendJson(res, 400, { success: false, error: error.message });
    }
    return;
  }

  // POST /api/command - Execute command
  if (method === 'POST' && url === '/api/command') {
    const body = await readBody(req, 1024 * 1024); // 1MB limit
    if (!body) {
      sendJson(res, 413, { success: false, error: 'Request body too large' });
      return;
    }

    try {
      const cmd = JSON.parse(body);
      const { executeCommand } = await import('../browser/executor.js');
      const result = await executeCommand(cmd, state);
      sendJson(res, 200, result);
    } catch (error: any) {
      sendJson(res, 400, { success: false, error: error.message });
    }
    return;
  }

  // GET /api/viewport - Current viewport size
  if (method === 'GET' && url === '/api/viewport') {
    const mgr = state.browser;
    if (!mgr) {
      sendJson(res, 200, { width: 1280, height: 720 });
      return;
    }

    try {
      const metrics = await mgr.client.sendCommand('Page.getLayoutMetrics', {});
      sendJson(res, 200, {
        width: metrics.visualViewport?.clientWidth || 1280,
        height: metrics.visualViewport?.clientHeight || 720,
      });
    } catch (error: any) {
      sendJson(res, 200, { width: 1280, height: 720 });
    }
    return;
  }

  // POST /api/screenshot - Take screenshot
  if (method === 'POST' && url === '/api/screenshot') {
    const mgr = state.browser;
    if (!mgr) {
      sendJson(res, 500, { success: false, error: 'Browser not launched' });
      return;
    }

    const sessionId = mgr.activeSessionId?.() || '';

    try {
      const result = await mgr.client.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      }, sessionId);

      sendJson(res, 200, {
        success: true,
        data: {
          base64: result.data,
        },
      });
    } catch (error: any) {
      sendJson(res, 500, { success: false, error: error.message });
    }
    return;
  }

  // 404 Not Found
  sendJson(res, 404, { error: 'Not found' });
}

async function serveDashboard(url: string, res: http.ServerResponse): Promise<void> {
  // Clean path
  let filePath = url.slice(1); // Remove leading /
  if (filePath === '' || filePath === '/') {
    filePath = 'index.html';
  }

  // Prevent directory traversal
  if (filePath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end('Forbidden');
    return;
  }

  // Determine static directory
  const staticDir = path.join(process.cwd(), 'static');
  const fullPath = path.join(staticDir, filePath);

  try {
    const content = await fs.readFile(fullPath);
    const contentType = getContentType(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      ...CORS_HEADERS,
    });
    res.end(content);
  } catch (error) {
    // Fallback to index.html for SPA routing
    try {
      const indexPath = path.join(staticDir, 'index.html');
      const content = await fs.readFile(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': content.length,
        ...CORS_HEADERS,
      });
      res.end(content);
    } catch (indexError) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
      res.end('<html><body><p>404 Not Found</p></body></html>');
    }
  }
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.txt': 'text/plain; charset=utf-8',
  };
  return types[ext] || 'application/octet-stream';
}

function sendJson(res: http.ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage, maxSize: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      resolve(body);
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

async function discoverSessions(): Promise<any[]> {
  const sessions: any[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const socketDir = path.join(homeDir, '.agent-browser');

  try {
    const files = await fs.readdir(socketDir);
    const pidFiles = files.filter((f) => f.endsWith('.pid'));

    for (const pidFile of pidFiles) {
      const sessionName = pidFile.slice(0, -4); // Remove .pid
      const pidPath = path.join(socketDir, pidFile);
      const versionPath = path.join(socketDir, `${sessionName}.version`);

      try {
        const pidStr = await fs.readFile(pidPath, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);

        // Check if process is running
        let running = false;
        try {
          process.kill(pid, 0); // Signal 0 checks existence
          running = true;
        } catch {
          running = false;
        }

        let version = 'unknown';
        try {
          version = (await fs.readFile(versionPath, 'utf-8')).trim();
        } catch {
          // Ignore version read errors
        }

        sessions.push({
          name: sessionName,
          pid,
          running,
          version,
        });
      } catch {
        // Ignore session read errors
      }
    }
  } catch {
    // Directory doesn't exist or other error
  }

  return sessions;
}
