import WebSocket from 'ws';
import type { CdpCommand, CdpMessage, CdpEvent } from '../types/cdp.js';
import { EventEmitter } from 'events';

const WS_KEEPALIVE_INTERVAL_MS = 30000; // 30 seconds

export interface RawCdpMessage {
  text: string;
  sessionId?: string;
}

interface PendingCommand {
  resolve: (value: CdpMessage) => void;
  reject: (error: Error) => void;
}

export class CdpClient extends EventEmitter {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private rawListeners: Array<(msg: RawCdpMessage) => void> = [];
  private keepaliveTimer?: NodeJS.Timeout;
  private closed = false;

  private constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.setupMessageHandler();
    this.startKeepalive();
  }

  static async connect(url: string, headers?: Record<string, string>): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const wsOptions: WebSocket.ClientOptions = {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024, // 256MB (no limit like Rust)
      };

      if (headers) {
        wsOptions.headers = headers;
      }

      const ws = new WebSocket(url, wsOptions);

      ws.on('open', () => {
        // Enable TCP keepalive on the underlying socket (best-effort)
        try {
          const socket = (ws as any)._socket;
          if (socket && socket.setKeepAlive) {
            socket.setKeepAlive(true, 30000); // 30 seconds
          }
        } catch {
          // Ignore errors - WebSocket ping provides primary liveness mechanism
        }

        resolve(new CdpClient(ws));
      });

      ws.on('error', (err) => {
        reject(new Error(`CDP WebSocket connect failed: ${err.message}`));
      });
    });
  }

  private setupMessageHandler(): void {
    this.ws.on('message', (data: WebSocket.Data) => {
      let text: string;

      // Accept both text and binary frames (remote CDP proxies may send Binary)
      if (typeof data === 'string') {
        text = data;
      } else if (Buffer.isBuffer(data)) {
        text = data.toString('utf-8');
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString('utf-8');
      } else {
        return;
      }

      // Broadcast raw message for inspect proxy subscribers before typed parse
      if (this.rawListeners.length > 0) {
        try {
          const parsed = JSON.parse(text);
          const sessionId = parsed.sessionId;
          this.emitRaw({ text, sessionId });
        } catch {
          // If parse fails, still broadcast without sessionId
          this.emitRaw({ text });
        }
      }

      // Parse typed CDP message
      let parsed: CdpMessage;
      try {
        parsed = JSON.parse(text) as CdpMessage;
      } catch {
        // Expected for inspect proxy messages with negative IDs
        return;
      }

      if (parsed.id !== undefined) {
        // Response to a command
        const handler = this.pending.get(parsed.id);
        if (handler) {
          this.pending.delete(parsed.id);
          handler.resolve(parsed);
        }
      } else if (parsed.method) {
        // Event
        const event: CdpEvent = {
          method: parsed.method,
          params: parsed.params || null,
          sessionId: parsed.sessionId,
        };
        this.emit('event', event);
        this.emit(parsed.method, event.params, event.sessionId);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.stopKeepalive();

      if (process.env.CLAW_BROWSER_DEBUG) {
        console.error(`[cdp] WebSocket Close: code=${code}, reason=${reason.toString()}`);
      }

      // Clear all pending commands with channel-closed error
      for (const [id, handler] of this.pending.entries()) {
        handler.reject(new Error('CDP response channel closed'));
      }
      this.pending.clear();
    });

    this.ws.on('error', (err) => {
      if (process.env.CLAW_BROWSER_DEBUG) {
        console.error(`[cdp] WebSocket Error: ${err.message}`);
      }
    });

    this.ws.on('pong', () => {
      // Keepalive pong received
    });
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
        this.stopKeepalive();
        return;
      }

      try {
        this.ws.ping();
      } catch (err) {
        if (process.env.CLAW_BROWSER_DEBUG) {
          console.error(`[cdp] Keepalive ping failed: ${err}`);
        }
        this.stopKeepalive();
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  async sendCommand(
    method: string,
    params?: unknown,
    sessionId?: string
  ): Promise<unknown> {
    const id = this.nextId++;

    const cmd: CdpCommand = {
      id,
      method,
      params: params || undefined,
      sessionId: sessionId && sessionId.length > 0 ? sessionId : undefined,
    };

    const json = JSON.stringify(cmd);

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response: CdpMessage) => {
          if (response.error) {
            reject(new Error(`CDP error (${method}): ${JSON.stringify(response.error)}`));
          } else {
            resolve(response.result || null);
          }
        },
        reject,
      });

      // Set 30-second timeout
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);

      // Clear timeout when resolved/rejected
      const originalResolve = this.pending.get(id)!.resolve;
      const originalReject = this.pending.get(id)!.reject;

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          originalResolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          originalReject(err);
        },
      });

      // Send the command
      try {
        this.ws.send(json, (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timeout);
            reject(new Error(`Failed to send CDP command: ${err.message}`));
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error(`Failed to send CDP command: ${err}`));
      }
    });
  }

  async sendCommandTyped<P, R>(
    method: string,
    params: P,
    sessionId?: string
  ): Promise<R> {
    const result = await this.sendCommand(method, params, sessionId);
    return result as R;
  }

  async sendCommandNoParams(method: string, sessionId?: string): Promise<unknown> {
    return this.sendCommand(method, undefined, sessionId);
  }

  /**
   * Send raw JSON through the WebSocket without tracking a response.
   * Used by the inspect proxy to forward DevTools frontend messages.
   */
  async sendRaw(json: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(json, (err) => {
        if (err) {
          reject(new Error(`Failed to send raw CDP message: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Subscribe to CDP events
   */
  subscribe(callback: (event: CdpEvent) => void): void {
    this.on('event', callback);
  }

  /**
   * Unsubscribe from CDP events
   */
  unsubscribe(callback: (event: CdpEvent) => void): void {
    this.off('event', callback);
  }

  /**
   * Subscribe to all raw incoming CDP messages (responses + events).
   * Used by the inspect proxy to forward traffic to the DevTools frontend.
   */
  subscribeRaw(callback: (msg: RawCdpMessage) => void): void {
    this.rawListeners.push(callback);
  }

  /**
   * Unsubscribe from raw CDP messages
   */
  unsubscribeRaw(callback: (msg: RawCdpMessage) => void): void {
    const index = this.rawListeners.indexOf(callback);
    if (index !== -1) {
      this.rawListeners.splice(index, 1);
    }
  }

  private emitRaw(msg: RawCdpMessage): void {
    for (const listener of this.rawListeners) {
      try {
        listener(msg);
      } catch (err) {
        if (process.env.CLAW_BROWSER_DEBUG) {
          console.error(`[cdp] Raw listener error: ${err}`);
        }
      }
    }
  }

  /**
   * Create a lightweight handle for the inspect WebSocket proxy.
   * Contains only what's needed to forward messages bidirectionally.
   */
  inspectHandle(): InspectProxyHandle {
    return new InspectProxyHandle(this);
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    this.closed = true;
    this.stopKeepalive();
    this.ws.close();
  }
}

/**
 * Lightweight handle for the inspect WebSocket proxy, holding only
 * the cloneable parts of CdpClient needed for bidirectional message forwarding.
 */
export class InspectProxyHandle {
  constructor(private client: CdpClient) {}

  async sendRaw(json: string): Promise<void> {
    return this.client.sendRaw(json);
  }

  subscribeRaw(callback: (msg: RawCdpMessage) => void): void {
    this.client.subscribeRaw(callback);
  }

  unsubscribeRaw(callback: (msg: RawCdpMessage) => void): void {
    this.client.unsubscribeRaw(callback);
  }
}
