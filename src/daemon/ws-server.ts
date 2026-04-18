import * as WebSocket from 'ws';
import * as http from 'http';
import type { DaemonState } from '../browser/state.js';
import { EventEmitter } from 'events';

/**
 * WebSocket streaming server for real-time CDP events
 * Translate from cli/src/native/stream/websocket.rs
 */

interface StreamMessage {
  type: string;
  [key: string]: any;
}

interface ClientState {
  ws: WebSocket;
  subscribed: boolean;
}

/**
 * WebSocket server for streaming CDP events to dashboard clients
 */
export class WebSocketStreamServer extends EventEmitter {
  private wss: WebSocket.Server;
  private clients: Set<ClientState> = new Set();
  private lastFrame: string | null = null;
  private lastTabs: any[] = [];
  private screencasting: boolean = false;
  private recording: boolean = false;
  private viewportWidth: number = 1280;
  private viewportHeight: number = 720;

  constructor(private state: DaemonState, httpServer?: http.Server) {
    super();

    this.wss = new WebSocket.Server({
      server: httpServer,
      noServer: !httpServer,
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      console.error('[ws] Server error:', error);
    });
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: StreamMessage): void {
    const json = JSON.stringify(message);

    // Cache frame messages
    if (message.type === 'frame') {
      this.lastFrame = json;
    }

    // Cache tabs
    if (message.type === 'tabs' && message.tabs) {
      this.lastTabs = message.tabs;
    }

    // Send to all clients
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN && client.subscribed) {
        try {
          client.ws.send(json);
        } catch (error) {
          console.error('[ws] Failed to send to client:', error);
        }
      }
    }
  }

  /**
   * Send status update to all clients
   */
  broadcastStatus(): void {
    const status: StreamMessage = {
      type: 'status',
      connected: this.state.browser !== null,
      screencasting: this.screencasting,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      engine: 'chrome',
      recording: this.recording,
    };
    this.broadcast(status);
  }

  /**
   * Update viewport size
   */
  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.broadcastStatus();
  }

  /**
   * Update screencasting state
   */
  setScreencasting(enabled: boolean): void {
    this.screencasting = enabled;
    this.broadcastStatus();
  }

  /**
   * Update recording state
   */
  setRecording(enabled: boolean): void {
    this.recording = enabled;
    this.broadcastStatus();
  }

  /**
   * Broadcast frame data (screenshot)
   */
  broadcastFrame(base64Data: string, metadata?: any): void {
    const message: StreamMessage = {
      type: 'frame',
      data: base64Data,
      timestamp: Date.now(),
      ...metadata,
    };
    this.broadcast(message);
  }

  /**
   * Broadcast tabs list
   */
  broadcastTabs(tabs: any[]): void {
    const message: StreamMessage = {
      type: 'tabs',
      tabs,
      timestamp: Date.now(),
    };
    this.broadcast(message);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Check origin for security
    const origin = req.headers.origin;
    if (origin && !this.isAllowedOrigin(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }

    const clientState: ClientState = {
      ws,
      subscribed: true,
    };

    this.clients.add(clientState);

    // Send initial status
    this.sendStatus(ws);

    // Send cached tabs if available
    if (this.lastTabs.length > 0) {
      this.sendTabs(ws, this.lastTabs);
    }

    // Send last frame if available
    if (this.lastFrame) {
      try {
        ws.send(this.lastFrame);
      } catch (error) {
        // Ignore send errors on initial frame
      }
    }

    // Handle incoming messages
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleClientMessage(message, clientState);
      } catch (error) {
        console.error('[ws] Failed to process client message:', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      this.clients.delete(clientState);
    });

    ws.on('error', (error) => {
      console.error('[ws] Client error:', error);
      this.clients.delete(clientState);
    });
  }

  /**
   * Send status to specific client
   */
  private sendStatus(ws: WebSocket): void {
    const status: StreamMessage = {
      type: 'status',
      connected: this.state.browser !== null,
      screencasting: this.screencasting,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      engine: 'chrome',
      recording: this.recording,
    };

    try {
      ws.send(JSON.stringify(status));
    } catch (error) {
      // Ignore send errors
    }
  }

  /**
   * Send tabs to specific client
   */
  private sendTabs(ws: WebSocket, tabs: any[]): void {
    const message: StreamMessage = {
      type: 'tabs',
      tabs,
      timestamp: Date.now(),
    };

    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      // Ignore send errors
    }
  }

  /**
   * Handle message from client
   */
  private async handleClientMessage(
    message: any,
    clientState: ClientState
  ): Promise<void> {
    const type = message.type;
    const mgr = this.state.browser;

    if (!mgr) {
      return;
    }

    const sessionId = mgr.activeSessionId?.() || '';

    try {
      switch (type) {
        case 'input_mouse':
          await mgr.client.sendCommand(
            'Input.dispatchMouseEvent',
            {
              type: message.eventType || 'mouseMoved',
              x: message.x || 0,
              y: message.y || 0,
              button: message.button || 'none',
              clickCount: message.clickCount || 0,
              deltaX: message.deltaX || 0,
              deltaY: message.deltaY || 0,
              modifiers: message.modifiers || 0,
            },
            sessionId
          );
          break;

        case 'input_keyboard':
          await mgr.client.sendCommand(
            'Input.dispatchKeyEvent',
            {
              type: message.eventType || 'keyDown',
              key: message.key,
              code: message.code,
              text: message.text,
              windowsVirtualKeyCode: message.windowsVirtualKeyCode || 0,
              modifiers: message.modifiers || 0,
            },
            sessionId
          );
          break;

        case 'input_touch':
          await mgr.client.sendCommand(
            'Input.dispatchTouchEvent',
            {
              type: message.eventType || 'touchStart',
              touchPoints: message.touchPoints || [],
              modifiers: message.modifiers || 0,
            },
            sessionId
          );
          break;

        case 'status':
          // Client requesting status update
          this.sendStatus(clientState.ws);
          break;

        default:
          // Unknown message type, ignore
          break;
      }
    } catch (error) {
      console.error('[ws] Failed to handle client message:', error);
    }
  }

  /**
   * Check if origin is allowed for CORS
   */
  private isAllowedOrigin(origin: string): boolean {
    // Allow localhost and 127.0.0.1 on any port
    if (
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('https://localhost:') ||
      origin.startsWith('https://127.0.0.1:')
    ) {
      return true;
    }

    // Allow file:// for local development
    if (origin === 'file://') {
      return true;
    }

    // Disallow all other origins
    return false;
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all connections and shut down server
   */
  close(): void {
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}

/**
 * Start WebSocket streaming server
 */
export async function startWebSocketServer(
  state: DaemonState,
  httpServer?: http.Server
): Promise<WebSocketStreamServer> {
  const wsServer = new WebSocketStreamServer(state, httpServer);

  // Subscribe to CDP events for streaming
  if (state.browser) {
    // Page.screencastFrame events
    state.browser.client.on('Page.screencastFrame', (params: any, sessionId?: string) => {
      if (params.data) {
        wsServer.broadcastFrame(params.data, {
          metadata: params.metadata,
          sessionId: params.sessionId,
        });

        // Acknowledge the frame
        state.browser?.client.sendCommand(
          'Page.screencastFrameAck',
          { sessionId: params.sessionId },
          sessionId
        ).catch(() => {
          // Ignore ack errors
        });
      }
    });

    // Target.targetInfoChanged events (for tabs)
    state.browser.client.on('Target.targetInfoChanged', async () => {
      try {
        const targets = await state.browser!.client.sendCommand('Target.getTargets', {});
        const tabs = (targets.targetInfos || [])
          .filter((t: any) => t.type === 'page')
          .map((t: any) => ({
            targetId: t.targetId,
            title: t.title,
            url: t.url,
            attached: t.attached,
          }));
        wsServer.broadcastTabs(tabs);
      } catch (error) {
        // Ignore errors
      }
    });
  }

  return wsServer;
}
