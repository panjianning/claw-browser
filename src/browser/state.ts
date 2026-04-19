import { EventEmitter } from 'events';
import type { CdpClient } from '../cdp/client.js';
import { EventTracker, DomainFilter } from '../cdp/network.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface PendingConfirmation {
  action: string;
  cmd: any;
}

export interface HarEntry {
  requestId: string;
  wallTime: number;
  method: string;
  url: string;
  requestHeaders: Array<[string, string]>;
  postData: string | null;
  requestBodySize: number;
  resourceType: string;
  status: number | null;
  statusText: string;
  httpVersion: string;
  responseHeaders: Array<[string, string]>;
  mimeType: string;
  redirectUrl: string;
  responseBodySize: number;
  cdpTiming: any | null;
  loadingFinishedTimestamp: number | null;
}

export interface RouteEntry {
  urlPattern: string;
  response: RouteResponse | null;
  abort: boolean;
}

export interface RouteResponse {
  status: number | null;
  body: string | null;
  contentType: string | null;
  headers: Record<string, string> | null;
}

export interface TrackedRequest {
  url: string;
  method: string;
  headers: any;
  timestamp: number;
  resourceType: string;
  requestId: string;
  postData?: string;
  status?: number;
  responseHeaders?: any;
  mimeType?: string;
}

export interface FetchPausedRequest {
  requestId: string;
  url: string;
  resourceType: string;
  sessionId: string;
  requestHeaders: Record<string, any> | null;
}

export enum BackendType {
  Cdp = 'cdp',
  WebDriver = 'webdriver',
}

export interface PendingDialog {
  dialogType: string;
  message: string;
  url: string;
  defaultPrompt: string | null;
}

export interface MouseState {
  x: number;
  y: number;
  buttons: number;
}

interface DrainedEvents {
  pendingAcks: number[];
  newTargets: any[];
  changedTargets: any[];
  destroyedTargets: string[];
  attachedIframeSessions: Array<[string, string]>;
  detachedIframeSessions: string[];
}

export interface TracingState {
  tracing: boolean;
  tracePath: string | null;
}

export interface RecordingState {
  recording: boolean;
  outputPath: string | null;
  captureTask: any | null;
  sharedFrameCount: any | null;
  cancelTx: any | null;
}

export interface ActionPolicy {
  reload(): void;
  check(action: string): PolicyResult;
}

export enum PolicyResult {
  Allow = 'allow',
  Deny = 'deny',
  RequiresConfirmation = 'requires_confirmation',
}

export interface ConfirmActions {
  requiresConfirmation(action: string): boolean;
}

// ============================================================================
// DaemonState Class
// ============================================================================

/**
 * Central state manager for the browser daemon.
 * Holds all browser state, CDP client references, trackers, and configuration.
 */
export class DaemonState extends EventEmitter {
  // Browser and backend
  browser: any | null = null;
  appium: any | null = null;
  safariDriver: any | null = null;
  webdriverBackend: any | null = null;
  backendType: BackendType = BackendType.Cdp;

  // Element and network tracking
  refMap: any; // RefMap instance
  domainFilter: DomainFilter | null = null;
  eventTracker: EventTracker;

  // Session info
  sessionName: string | null = null;
  sessionId: string;

  // Tracing and recording
  tracingState: TracingState = {
    tracing: false,
    tracePath: null,
  };
  recordingState: RecordingState = {
    recording: false,
    outputPath: null,
    captureTask: null,
    sharedFrameCount: null,
    cancelTx: null,
  };

  // Event subscription
  private eventRx: EventEmitter | null = null;

  // Screencasting
  screencasting = false;

  // Policy
  policy: ActionPolicy | null = null;
  pendingConfirmation: PendingConfirmation | null = null;

  // HAR recording
  harRecording = false;
  harEntries: HarEntry[] = [];

  // Confirmation actions
  confirmActions: ConfirmActions | null = null;

  // Inspect server
  inspectServer: any | null = null;

  // Route interception
  routes: RouteEntry[] = [];

  // Request tracking
  trackedRequests: TrackedRequest[] = [];
  requestTracking = false;

  // Frame management
  activeFrameId: string | null = null;
  iframeSessions: Map<string, string> = new Map();

  // Origin-scoped headers
  originHeaders: Map<string, Map<string, string>> = new Map();

  // Proxy credentials
  proxyCredentials: { username: string; password: string } | null = null;

  // Launch hash for relaunch detection
  launchHash: string | null = null;

  // Is CDP connection (vs launched browser)
  isCdpConnection = false;
  // Last requested external CDP target key for connect target change detection.
  externalTargetKey: string | null = null;

  // Background tasks
  private fetchHandlerTask: any | null = null;
  private dialogHandlerTask: any | null = null;

  // Mouse state
  mouseState: MouseState = {
    x: 0,
    y: 0,
    buttons: 0,
  };

  // Dialog handling
  pendingDialog: PendingDialog | null = null;
  autoDialog = true;

  // Stream server
  streamClient: any | null = null;
  streamServer: any | null = null;

  // Browser engine name
  engine: string;

  // Default timeout
  defaultTimeoutMs: number;

  // Visited origins for state persistence
  visitedOrigins: Set<string> = new Set();

  constructor() {
    super();

    // Load from environment variables
    const allowedDomains = process.env.CLAW_BROWSER_ALLOWED_DOMAINS;
    if (allowedDomains && allowedDomains.trim()) {
      this.domainFilter = new DomainFilter(allowedDomains.split(',').map((s) => s.trim()));
    }

    this.eventTracker = new EventTracker();
    this.sessionName = process.env.CLAW_BROWSER_SESSION_NAME || null;
    this.sessionId = process.env.CLAW_BROWSER_SESSION || 'default';

    // Auto-dialog disabled if env var is set
    const noAutoDialog = process.env.CLAW_BROWSER_NO_AUTO_DIALOG;
    this.autoDialog = !(noAutoDialog === '1' || noAutoDialog === 'true' || noAutoDialog === 'yes');

    this.engine = process.env.CLAW_BROWSER_ENGINE || 'chrome';

    // Parse default timeout
    const timeoutStr = process.env.CLAW_BROWSER_DEFAULT_TIMEOUT;
    this.defaultTimeoutMs = timeoutStr ? parseInt(timeoutStr, 10) || 30000 : 30000;

    // Initialize refMap (placeholder for now, will be implemented in element.ts)
    this.refMap = new Map();

    // Load policy if exists (placeholder for now)
    this.policy = null;

    // Load confirm actions from env (placeholder for now)
    this.confirmActions = null;
  }

  /**
   * Create state with stream client slot and server instance.
   */
  static newWithStream(streamClient: any | null, streamServer: any | null): DaemonState {
    const state = new DaemonState();
    if (streamServer) {
      state.requestTracking = true;
    }
    state.streamClient = streamClient;
    state.streamServer = streamServer;
    return state;
  }

  /**
   * Extract timeout from command JSON, falling back to configured default.
   */
  timeoutMs(cmd: any): number {
    const timeout = cmd.timeout;
    if (typeof timeout === 'number' && timeout > 0) {
      return timeout;
    }
    return this.defaultTimeoutMs;
  }

  /**
   * Reset input state (mouse, etc.).
   */
  resetInputState(): void {
    this.mouseState = {
      x: 0,
      y: 0,
      buttons: 0,
    };
  }

  /**
   * Subscribe to browser CDP events.
   */
  subscribeToEvents(): void {
    if (this.browser && this.browser.client) {
      this.eventRx = this.browser.client;
    }
  }

  /**
   * Check if browser process has exited (for launched browsers).
   */
  hasProcessExited(): boolean {
    // Check if we have a browser process and if it has exited
    if (!this.browser) {
      return false;
    }

    // If the browser has a chromeProcess property (from launch), check if it exited
    const browserAny = this.browser as any;
    if (browserAny.chromeProcess && typeof browserAny.chromeProcess.hasExited === 'function') {
      return browserAny.chromeProcess.hasExited();
    }

    // For CDP connections (not launched), process exit detection not applicable
    return false;
  }

  /**
   * Check if CDP connection is alive.
   */
  async isConnectionAlive(): Promise<boolean> {
    if (!this.browser || !this.browser.client) {
      return false;
    }
    try {
      await this.browser.client.sendCommand('Browser.getVersion', {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start background task for processing Fetch.requestPaused events.
   */
  startFetchHandler(): void {
    // Abort any existing handler
    if (this.fetchHandlerTask) {
      this.stopFetchHandler();
    }

    if (!this.browser) {
      return;
    }

    const client = this.browser.client;
    const domainFilter = this.domainFilter;
    const routes = this.routes;
    const originHeaders = this.originHeaders;
    const proxyCredentials = this.proxyCredentials;

    // Start listening to Fetch events
    const handleFetchRequest = async (params: any) => {
      const requestId = params.requestId;
      const request = params.request || {};
      const url = request.url || '';
      const resourceType = params.resourceType || '';
      const sessionId = params.sessionId || '';
      const requestHeaders = request.headers || null;

      const paused: FetchPausedRequest = {
        requestId,
        url,
        resourceType,
        sessionId,
        requestHeaders,
      };

      await this.resolveFetchPaused(client, domainFilter, routes, originHeaders, paused);
    };

    client.on('Fetch.requestPaused', handleFetchRequest);
    this.fetchHandlerTask = handleFetchRequest;

    // Also handle Fetch.authRequired for proxy authentication
    const handleAuthRequired = async (params: any) => {
      const requestId = params.requestId;
      const sessionId = params.sessionId || '';

      if (proxyCredentials) {
        const username = proxyCredentials.username;
        const password = proxyCredentials.password;
        await client.sendCommand(
          'Fetch.continueWithAuth',
          {
            requestId,
            authChallengeResponse: {
              response: 'ProvideCredentials',
              username,
              password,
            },
          },
          sessionId
        );
      } else {
        await client.sendCommand(
          'Fetch.continueWithAuth',
          {
            requestId,
            authChallengeResponse: {
              response: 'CancelAuth',
            },
          },
          sessionId
        );
      }
    };

    client.on('Fetch.authRequired', handleAuthRequired);
  }

  /**
   * Stop background fetch handler.
   */
  stopFetchHandler(): void {
    if (this.fetchHandlerTask && this.browser) {
      this.browser.client.off('Fetch.requestPaused', this.fetchHandlerTask);
      this.fetchHandlerTask = null;
    }
  }

  /**
   * Resolve a paused Fetch request (domain filtering, route interception, headers).
   */
  private async resolveFetchPaused(
    client: CdpClient,
    domainFilter: DomainFilter | null,
    routes: RouteEntry[],
    originHeaders: Map<string, Map<string, string>>,
    paused: FetchPausedRequest
  ): Promise<void> {
    try {
      const url = new URL(paused.url);
      const domain = url.hostname;

      // Domain filtering
      if (domainFilter && !domainFilter.isAllowed(domain)) {
        await client.sendCommand(
          'Fetch.failRequest',
          {
            requestId: paused.requestId,
            errorReason: 'BlockedByClient',
          },
          paused.sessionId
        );
        return;
      }

      // Route interception
      for (const route of routes) {
        if (this.matchUrlPattern(paused.url, route.urlPattern)) {
          if (route.abort) {
            await client.sendCommand(
              'Fetch.failRequest',
              {
                requestId: paused.requestId,
                errorReason: 'Aborted',
              },
              paused.sessionId
            );
            return;
          }

          if (route.response) {
            await client.sendCommand(
              'Fetch.fulfillRequest',
              {
                requestId: paused.requestId,
                responseCode: route.response.status || 200,
                body: route.response.body
                  ? Buffer.from(route.response.body).toString('base64')
                  : undefined,
                responseHeaders: route.response.headers
                  ? Object.entries(route.response.headers).map(([name, value]) => ({ name, value }))
                  : undefined,
              },
              paused.sessionId
            );
            return;
          }
        }
      }

      // Origin-scoped headers
      const origin = `${url.protocol}//${url.host}`;
      const extraHeaders = originHeaders.get(origin);
      if (extraHeaders && extraHeaders.size > 0) {
        const mergedHeaders = { ...(paused.requestHeaders || {}), ...Object.fromEntries(extraHeaders) };
        await client.sendCommand(
          'Fetch.continueRequest',
          {
            requestId: paused.requestId,
            headers: Object.entries(mergedHeaders).map(([name, value]) => ({ name, value })),
          },
          paused.sessionId
        );
        return;
      }

      // Continue normally
      await client.sendCommand('Fetch.continueRequest', { requestId: paused.requestId }, paused.sessionId);
    } catch (error) {
      // On error, continue the request
      try {
        await client.sendCommand('Fetch.continueRequest', { requestId: paused.requestId }, paused.sessionId);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Match URL against a pattern (basic wildcard support).
   */
  private matchUrlPattern(url: string, pattern: string): boolean {
    // Simple wildcard matching: convert * to .*
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(url);
  }

  /**
   * Start background task for auto-accepting alert/beforeunload dialogs.
   */
  startDialogHandler(): void {
    if (this.dialogHandlerTask) {
      this.stopDialogHandler();
    }

    if (!this.autoDialog || !this.browser) {
      return;
    }

    const client = this.browser.client;

    const handleDialog = async (params: any) => {
      const dialogType = params.type;
      const message = params.message || '';
      this.pendingDialog = {
        dialogType,
        message,
        url: params.url || '',
        defaultPrompt: params.defaultPrompt || null,
      };

      if (dialogType === 'beforeunload' || dialogType === 'alert') {
        console.error(`[auto-dismiss] ${dialogType} dialog: ${message}`);
        const sessionId = params.sessionId || '';
        try {
          await client.sendCommand(
            'Page.handleJavaScriptDialog',
            { accept: true },
            sessionId
          );
          this.pendingDialog = null;
        } catch (error) {
          console.error(`[auto-dismiss] failed to dismiss ${dialogType} dialog:`, error);
        }
      }
    };

    client.on('Page.javascriptDialogOpening', handleDialog);
    this.dialogHandlerTask = handleDialog;
  }

  /**
   * Stop background dialog handler.
   */
  stopDialogHandler(): void {
    if (this.dialogHandlerTask && this.browser) {
      this.browser.client.off('Page.javascriptDialogOpening', this.dialogHandlerTask);
      this.dialogHandlerTask = null;
    }
  }

  /**
   * Update stream server CDP client slot.
   */
  async updateStreamClient(): Promise<void> {
    if (this.streamClient) {
      this.streamClient.value = this.browser ? this.browser.client : null;
    }

    if (this.streamServer) {
      // Update CDP session ID
      const sessionId = this.browser?.activeSessionId?.() || null;
      await this.streamServer.setCdpSessionId(sessionId);

      // Broadcast connection status
      const connected = this.browser !== null;
      const screencasting = this.screencasting;
      const [viewportWidth, viewportHeight] = await this.streamServer.viewport();
      await this.streamServer.broadcastStatus(
        connected,
        screencasting,
        viewportWidth,
        viewportHeight,
        this.engine
      );

      if (this.browser) {
        await this.streamServer.broadcastTabs(this.browser.tabList());
      } else {
        await this.streamServer.broadcastTabs([]);
      }

      // Notify client changed
      this.streamServer.notifyClientChanged();
    }
  }

  /**
   * Start recording task (video capture).
   */
  async startRecordingTask(client: CdpClient, sessionId: string): Promise<void> {
    // Placeholder for recording implementation
    throw new Error('Recording not yet implemented');
  }

  /**
   * Stop recording task.
   */
  async stopRecordingTask(): Promise<void> {
    // Placeholder for recording implementation
    throw new Error('Recording not yet implemented');
  }

  /**
   * Drain CDP events from the event channel and apply them to state.
   */
  async drainCdpEventsBackground(): Promise<void> {
    const drained = this.drainCdpEvents();
    await this.applyDrainedEvents(drained);
  }

  /**
   * Drain pending CDP events from the broadcast channel.
   */
  private drainCdpEvents(): DrainedEvents {
    const drained: DrainedEvents = {
      pendingAcks: [],
      newTargets: [],
      changedTargets: [],
      destroyedTargets: [],
      attachedIframeSessions: [],
      detachedIframeSessions: [],
    };

    if (!this.eventRx) {
      return drained;
    }

    // In Node.js, EventEmitter doesn't have a try_recv equivalent
    // We'll process events synchronously from listeners
    // For now, return empty drained events
    // TODO: Implement proper event draining with a queue

    return drained;
  }

  /**
   * Apply drained events to state.
   */
  private async applyDrainedEvents(drained: DrainedEvents): Promise<void> {
    // ACK screencast frames
    if (drained.pendingAcks.length > 0 && this.browser) {
      const sessionId = this.browser.activeSessionId?.();
      if (sessionId) {
        for (const ackSid of drained.pendingAcks) {
          try {
            await this.browser.client.sendCommand(
              'Page.screencastFrameAck',
              { sessionId: ackSid },
              sessionId
            );
          } catch {
            // Ignore
          }
        }
      }
    }

    // Remove destroyed targets
    for (const targetId of drained.destroyedTargets) {
      if (this.browser) {
        this.browser.removePageByTargetId?.(targetId);
      }
    }

    // Track cross-origin iframe sessions
    for (const [frameId, iframeSessionId] of drained.attachedIframeSessions) {
      this.iframeSessions.set(frameId, iframeSessionId);

      if (this.browser) {
        const client = this.browser.client;
        await client.sendCommand('Runtime.runIfWaitingForDebugger', {}, iframeSessionId);
        await client.sendCommand('DOM.enable', {}, iframeSessionId);
        await client.sendCommand('Accessibility.enable', {}, iframeSessionId);

        if (this.harRecording || this.requestTracking) {
          await client.sendCommand('Network.enable', {}, iframeSessionId);
        }
      }
    }

    for (const sessionId of drained.detachedIframeSessions) {
      for (const [frameId, sid] of this.iframeSessions) {
        if (sid === sessionId) {
          this.iframeSessions.delete(frameId);
          break;
        }
      }
    }

    // Attach and register new targets
    for (const targetEvent of drained.newTargets) {
      if (this.browser) {
        // Placeholder for target attachment logic
        // TODO: Implement target attachment
      }
    }

    // Update changed targets
    for (const targetEvent of drained.changedTargets) {
      if (this.browser) {
        this.browser.updatePageTargetInfo?.(targetEvent.targetInfo);
      }
    }
  }

  /**
   * Cleanup resources.
   */
  dispose(): void {
    this.stopFetchHandler();
    this.stopDialogHandler();
  }
}
