import { CdpClient } from './client.js';
import type { CdpEvent } from '../types/cdp.js';
import type { ChromeProcess, LaunchOptions } from '../utils/chrome-launcher.js';

export interface PageInfo {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  targetType: string; // "page" or "webview"
}

export enum WaitUntil {
  Load = 'load',
  DomContentLoaded = 'domcontentloaded',
  NetworkIdle = 'networkidle',
  None = 'none',
}

export function waitUntilFromString(s: string): WaitUntil {
  switch (s.toLowerCase()) {
    case 'domcontentloaded':
      return WaitUntil.DomContentLoaded;
    case 'networkidle':
      return WaitUntil.NetworkIdle;
    case 'none':
      return WaitUntil.None;
    default:
      return WaitUntil.Load;
  }
}

/**
 * Returns true for Chrome internal targets that should not be selected
 * during auto-connect (e.g. chrome://, chrome-extension://, devtools://).
 */
function isInternalChromeTarget(url: string): boolean {
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://')
  );
}

export function shouldTrackTarget(target: TargetInfo): boolean {
  return (
    (target.type === 'page' || target.type === 'webview') &&
    (!target.url || !isInternalChromeTarget(target.url))
  );
}

/**
 * Converts common error messages into AI-friendly, actionable descriptions.
 */
export function toAiFriendlyError(error: string): string {
  const lower = error.toLowerCase();

  if (lower.includes('strict mode violation')) {
    return 'Element matched multiple results. Use a more specific selector.';
  }
  if (lower.includes('element is not visible')) {
    return 'Element exists but is not visible. Wait for it to become visible or scroll it into view.';
  }
  if (lower.includes('intercept')) {
    return 'Another element is covering the target element. Try scrolling or closing overlays.';
  }
  if (lower.includes('timeout')) {
    return 'Operation timed out. The page may still be loading or the element may not exist.';
  }
  if (lower.includes('element not found') || lower.includes('no element')) {
    return 'Element not found. Verify the selector is correct and the element exists in the DOM.';
  }

  return error;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerTargetId?: string;
  canAccessOpener: boolean;
  browserContextId?: string;
}

interface CreateTargetResult {
  targetId: string;
}

interface AttachToTargetResult {
  sessionId: string;
}

interface GetTargetsResult {
  targetInfos: TargetInfo[];
}

interface PageNavigateParams {
  url: string;
  referrer?: string;
}

interface PageNavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

interface EvaluateParams {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

interface EvaluateResult {
  result: {
    type: string;
    value?: any;
    description?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: {
      description?: string;
    };
  };
}

export class BrowserManager {
  public client: CdpClient;
  private wsUrl: string;
  private pages: PageInfo[] = [];
  private activePageIndex = 0;
  private tabLabels = new Map<string, string>();
  private defaultTimeoutMs = 25000;
  public downloadPath?: string;
  public ignoreHttpsErrors = false;
  private visitedOrigins = new Set<string>();
  private chromeProcess?: ChromeProcess;

  constructor(client: CdpClient, wsUrl: string) {
    this.client = client;
    this.wsUrl = wsUrl;
  }

  /**
   * Launch a new Chrome/Chromium instance and connect to it
   */
  static async launch(options: LaunchOptions = {}): Promise<BrowserManager> {
    const { launchChrome } = await import('../utils/chrome-launcher.js');
    const chromeProcess = await launchChrome(options);

    const client = await CdpClient.connect(chromeProcess.wsUrl);
    const manager = new BrowserManager(client, chromeProcess.wsUrl);
    manager.chromeProcess = chromeProcess;

    await manager.discoverAndAttachTargets();

    // Configure browser settings
    const sessionId = manager.activeSessionId();

    if (options.ignoreHTTPSErrors) {
      await client.sendCommand(
        'Security.setIgnoreCertificateErrors',
        { ignore: true },
        sessionId
      );
    }

    if (options.userAgent) {
      await client.sendCommand(
        'Network.setUserAgentOverride',
        { userAgent: options.userAgent },
        sessionId
      );
    }

    if (options.downloadPath) {
      await client.sendCommand(
        'Page.setDownloadBehavior',
        {
          behavior: 'allow',
          downloadPath: options.downloadPath,
        },
        sessionId
      );
    }

    return manager;
  }

  /**
   * Connect to an existing Chrome DevTools Protocol endpoint
   */
  static async connect(url: string, headers?: Record<string, string>): Promise<BrowserManager> {
    return BrowserManager.connectInner(url, false, headers);
  }

  /**
   * Connect to a provider CDP proxy where the WebSocket IS the page session.
   * Skips browser-level Target.* commands that most proxies don't support.
   */
  static async connectDirect(url: string): Promise<BrowserManager> {
    return BrowserManager.connectInner(url, true, undefined);
  }

  private static async connectInner(
    url: string,
    directPage: boolean,
    headers?: Record<string, string>
  ): Promise<BrowserManager> {
    const wsUrl = await resolveDevToolsUrl(url);
    const client = await CdpClient.connect(wsUrl, headers);
    const manager = new BrowserManager(client, wsUrl);

    if (directPage) {
      // Direct page connection - no target management
      manager.pages.push({
        targetId: 'provider-page',
        sessionId: '',
        url: '',
        title: '',
        targetType: 'page',
      });
      manager.activePageIndex = 0;
      await manager.enableDomainsDirect();
    } else {
      // Full browser connection - discover and attach to targets
      await manager.discoverAndAttachTargets();
    }

    return manager;
  }

  private async discoverAndAttachTargets(): Promise<void> {
    // Rebuild page/session mapping from scratch to avoid stale session IDs.
    this.pages = [];
    this.activePageIndex = 0;

    // Enable target discovery
    await this.client.sendCommand('Target.setDiscoverTargets', { discover: true });

    // Get all existing targets
    const result = (await this.client.sendCommand('Target.getTargets', {})) as GetTargetsResult;

    const pageTargets = result.targetInfos.filter(shouldTrackTarget);

    if (pageTargets.length === 0) {
      // No pages found, create a new one
      const createResult = (await this.client.sendCommand('Target.createTarget', {
        url: 'about:blank',
      })) as CreateTargetResult;

      const attachResult = (await this.client.sendCommand('Target.attachToTarget', {
        targetId: createResult.targetId,
        flatten: true,
      })) as AttachToTargetResult;

      this.pages.push({
        targetId: createResult.targetId,
        sessionId: attachResult.sessionId,
        url: 'about:blank',
        title: '',
        targetType: 'page',
      });
      this.activePageIndex = 0;
      await this.enableDomains(attachResult.sessionId);
    } else {
      // Attach to existing pages
      for (const target of pageTargets) {
        const attachResult = (await this.client.sendCommand('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        })) as AttachToTargetResult;

        this.pages.push({
          targetId: target.targetId,
          sessionId: attachResult.sessionId,
          url: target.url,
          title: target.title,
          targetType: target.type,
        });
      }

      this.activePageIndex = 0;
      const sessionId = this.pages[0].sessionId;
      await this.enableDomains(sessionId);
    }

    this.pruneTabLabels();
  }

  private async enableDomains(sessionId: string): Promise<void> {
    await this.client.sendCommandNoParams('Page.enable', sessionId);
    await this.client.sendCommandNoParams('Runtime.enable', sessionId);

    // Resume the target if it is paused waiting for the debugger
    try {
      await this.client.sendCommandNoParams('Runtime.runIfWaitingForDebugger', sessionId);
    } catch {
      // Ignore errors
    }

    await this.client.sendCommandNoParams('Network.enable', sessionId);

    // Enable auto-attach for cross-origin iframe support
    try {
      await this.client.sendCommand(
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        sessionId
      );
    } catch {
      // Ignore if not supported
    }
  }

  private async enableDomainsDirect(): Promise<void> {
    await this.client.sendCommandNoParams('Page.enable');
    await this.client.sendCommandNoParams('Runtime.enable');

    try {
      await this.client.sendCommandNoParams('Runtime.runIfWaitingForDebugger');
    } catch {
      // Ignore errors
    }

    await this.client.sendCommandNoParams('Network.enable');
  }

  public activeSessionId(): string {
    const page = this.pages[this.activePageIndex];
    if (!page) {
      throw new Error('No active page');
    }
    return page.sessionId;
  }

  public activeTargetId(): string {
    const page = this.pages[this.activePageIndex];
    if (!page) {
      throw new Error('No active page');
    }
    return page.targetId;
  }

  public async navigate(url: string, waitUntil: WaitUntil = WaitUntil.Load): Promise<any> {
    return this.withSessionRecovery(async () => {
      const sessionId = this.activeSessionId();

      const result = (await this.client.sendCommand(
        'Page.navigate',
        {
          url,
          referrer: undefined,
        } as PageNavigateParams,
        sessionId
      )) as PageNavigateResult;

      if (result.errorText) {
        throw new Error(`Navigation failed: ${result.errorText}`);
      }

      // Only wait for lifecycle events if Chrome created a new loader (full navigation)
      if (result.loaderId && waitUntil !== WaitUntil.None) {
        await this.waitForLifecycle(waitUntil, sessionId);
      }

      const pageUrl = await this.getUrl().catch(() => url);
      const title = await this.getTitle().catch(() => '');

      // Track visited origin for cross-origin localStorage collection
      try {
        const parsed = new URL(pageUrl);
        const origin = parsed.origin;
        if (origin !== 'null') {
          this.visitedOrigins.add(origin);
        }
      } catch {
        // Invalid URL, skip tracking
      }

      // Update page info
      const page = this.pages[this.activePageIndex];
      if (page) {
        page.url = pageUrl;
        page.title = title;
      }

      return { url: pageUrl, title };
    });
  }

  private async waitForLifecycle(waitUntil: WaitUntil, sessionId: string): Promise<void> {
    if (waitUntil === WaitUntil.NetworkIdle) {
      return this.waitForNetworkIdle(sessionId);
    }

    const eventName =
      waitUntil === WaitUntil.DomContentLoaded
        ? 'Page.domContentEventFired'
        : 'Page.loadEventFired';

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for ${eventName}`));
      }, this.defaultTimeoutMs);

      const handler = (event: CdpEvent) => {
        if (event.method === eventName && event.sessionId === sessionId) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.client.unsubscribe(handler);
      };

      this.client.subscribe(handler);
    });
  }

  private async waitForNetworkIdle(sessionId: string): Promise<void> {
    const IDLE_TIME_MS = 500;
    const MAX_INFLIGHT = 2;

    let inflightRequests = 0;
    let lastNetworkActivity = Date.now();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for network idle'));
      }, this.defaultTimeoutMs);

      const checkIdle = () => {
        if (inflightRequests <= MAX_INFLIGHT && Date.now() - lastNetworkActivity >= IDLE_TIME_MS) {
          cleanup();
          resolve();
        }
      };

      const handler = (event: CdpEvent) => {
        if (event.sessionId !== sessionId) return;

        if (event.method === 'Network.requestWillBeSent') {
          inflightRequests++;
          lastNetworkActivity = Date.now();
        } else if (
          event.method === 'Network.responseReceived' ||
          event.method === 'Network.loadingFinished' ||
          event.method === 'Network.loadingFailed'
        ) {
          inflightRequests = Math.max(0, inflightRequests - 1);
          lastNetworkActivity = Date.now();
        }

        checkIdle();
      };

      const idleInterval = setInterval(checkIdle, 100);

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(idleInterval);
        this.client.unsubscribe(handler);
      };

      this.client.subscribe(handler);
    });
  }

  public async getUrl(): Promise<string> {
    const result = await this.evaluateSimple('location.href');
    return typeof result === 'string' ? result : '';
  }

  public async getTitle(): Promise<string> {
    const result = await this.evaluateSimple('document.title');
    return typeof result === 'string' ? result : '';
  }

  public async getContent(): Promise<string> {
    const result = await this.evaluateSimple('document.documentElement.outerHTML');
    return typeof result === 'string' ? result : '';
  }

  public async evaluate(script: string, args?: any): Promise<any> {
    return this.withSessionRecovery(async () => {
      const sessionId = this.activeSessionId();

      const result = (await this.client.sendCommand(
        'Runtime.evaluate',
        {
          expression: script,
          returnByValue: true,
          awaitPromise: true,
        } as EvaluateParams,
        sessionId
      )) as EvaluateResult;

      if (result.exceptionDetails) {
        const msg =
          result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(`Evaluation error: ${msg}`);
      }

      return result.result.value ?? null;
    });
  }

  private isSessionGoneError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('Session with given id not found') ||
      message.includes('No session with given id') ||
      message.includes('Invalid session id')
    );
  }

  private async withSessionRecovery<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (!this.isSessionGoneError(error)) {
        throw error;
      }

      await this.discoverAndAttachTargets();
      return op();
    }
  }

  private async evaluateSimple(expression: string): Promise<any> {
    return this.evaluate(expression);
  }

  public async close(): Promise<void> {
    // Only close the whole browser when this manager launched it.
    // For external CDP connections, just detach our client.
    if (this.chromeProcess) {
      try {
        await this.client.sendCommandNoParams('Browser.close');
      } catch {
        // Ignore errors
      }
    }

    this.client.close();

    // Kill Chrome process if we launched it.
    if (this.chromeProcess) {
      this.chromeProcess.kill();
    }
  }

  public hasPages(): boolean {
    return this.pages.length > 0;
  }

  public getDefaultTimeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  public setDefaultTimeout(ms: number): void {
    this.defaultTimeoutMs = ms;
  }

  /**
   * Checks if the CDP connection is alive by sending a simple command.
   */
  public async isConnectionAlive(): Promise<boolean> {
    try {
      await Promise.race([
        this.client.sendCommandNoParams('Browser.getVersion'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  public getCdpUrl(): string {
    return this.wsUrl;
  }

  /**
   * Returns the Chrome debug server address as "host:port".
   */
  public chromeHostPort(): string {
    const stripped =
      this.wsUrl.replace(/^wss?:\/\//, '');
    return stripped.split('/')[0] || stripped;
  }

  /**
   * Ensures the browser has at least one page. If pages is empty, creates a new
   * about:blank page and attaches to it.
   */
  public async ensurePage(): Promise<void> {
    if (this.pages.length > 0) {
      return;
    }

    const createResult = (await this.client.sendCommand('Target.createTarget', {
      url: 'about:blank',
    })) as CreateTargetResult;

    const attachResult = (await this.client.sendCommand('Target.attachToTarget', {
      targetId: createResult.targetId,
      flatten: true,
    })) as AttachToTargetResult;

    this.pages.push({
      targetId: createResult.targetId,
      sessionId: attachResult.sessionId,
      url: 'about:blank',
      title: '',
      targetType: 'page',
    });

    this.activePageIndex = 0;
    await this.enableDomains(attachResult.sessionId);
  }

  public getPages(): PageInfo[] {
    return [...this.pages];
  }

  public pageCount(): number {
    return this.pages.length;
  }

  public tabList(): Array<{ id: string; tabId: string; title: string; url: string; active: boolean; index: number; shortId: string; label?: string }> {
    return this.pages.map((p, index) => ({
      id: p.targetId,
      tabId: p.targetId,
      title: p.title,
      url: p.url,
      active: index === this.activePageIndex,
      index,
      shortId: this.shortTabId(index),
      label: this.tabLabels.get(p.targetId),
    }));
  }

  public getActivePage(): PageInfo | undefined {
    return this.pages[this.activePageIndex];
  }

  public setActivePage(index: number): void {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid page index: ${index}`);
    }
    this.activePageIndex = index;
  }

  public setActivePageByTargetId(tabId: string): void {
    const index = this.pages.findIndex((p) => p.targetId === tabId);
    if (index === -1) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    this.activePageIndex = index;
  }

  public setActivePageByShortId(shortId: string): void {
    const parsed = this.parseShortId(shortId);
    if (parsed === null) {
      throw new Error(`Invalid tab reference: ${shortId}`);
    }
    this.setActivePage(parsed);
  }

  public setActivePageByLabel(label: string): void {
    const targetId = this.findTargetIdByLabel(label);
    if (!targetId) {
      throw new Error(`Tab label not found: ${label}`);
    }
    this.setActivePageByTargetId(targetId);
  }

  public async createNewPage(): Promise<PageInfo> {
    const createResult = (await this.client.sendCommand('Target.createTarget', {
      url: 'about:blank',
    })) as CreateTargetResult;

    const attachResult = (await this.client.sendCommand('Target.attachToTarget', {
      targetId: createResult.targetId,
      flatten: true,
    })) as AttachToTargetResult;

    const newPage: PageInfo = {
      targetId: createResult.targetId,
      sessionId: attachResult.sessionId,
      url: 'about:blank',
      title: '',
      targetType: 'page',
    };

    this.pages.push(newPage);
    await this.enableDomains(attachResult.sessionId);

    return newPage;
  }

  public async createNewWindow(): Promise<PageInfo> {
    const createResult = (await this.client.sendCommand('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    })) as CreateTargetResult;

    const attachResult = (await this.client.sendCommand('Target.attachToTarget', {
      targetId: createResult.targetId,
      flatten: true,
    })) as AttachToTargetResult;

    const newPage: PageInfo = {
      targetId: createResult.targetId,
      sessionId: attachResult.sessionId,
      url: 'about:blank',
      title: '',
      targetType: 'page',
    };

    this.pages.push(newPage);
    this.activePageIndex = this.pages.length - 1;
    await this.enableDomains(attachResult.sessionId);
    return newPage;
  }

  public async closePage(targetId: string): Promise<void> {
    const index = this.pages.findIndex((p) => p.targetId === targetId);
    if (index === -1) {
      throw new Error(`Page not found: ${targetId}`);
    }

    await this.client.sendCommand('Target.closeTarget', { targetId });
    this.pages.splice(index, 1);
    this.tabLabels.delete(targetId);

    // Adjust active page index if needed
    if (this.activePageIndex >= this.pages.length && this.pages.length > 0) {
      this.activePageIndex = this.pages.length - 1;
    }
  }

  public async closePageByIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid tab index: ${index}`);
    }
    await this.closePage(this.pages[index].targetId);
  }

  public updatePageTargetInfo(targetInfo: Partial<PageInfo> & { targetId?: string; title?: string; url?: string }): void {
    if (!targetInfo.targetId) {
      return;
    }
    const page = this.pages.find((p) => p.targetId === targetInfo.targetId);
    if (!page) {
      return;
    }
    if (typeof targetInfo.title === 'string') {
      page.title = targetInfo.title;
    }
    if (typeof targetInfo.url === 'string') {
      page.url = targetInfo.url;
    }
  }

  public removePageByTargetId(targetId: string): void {
    const index = this.pages.findIndex((p) => p.targetId === targetId);
    if (index === -1) {
      return;
    }
    this.pages.splice(index, 1);
    this.tabLabels.delete(targetId);
    if (this.activePageIndex >= this.pages.length && this.pages.length > 0) {
      this.activePageIndex = this.pages.length - 1;
    }
    if (this.pages.length === 0) {
      this.activePageIndex = 0;
    }
  }

  public shortTabId(index: number): string {
    return `t${index + 1}`;
  }

  public parseShortId(value: string): number | null {
    const m = /^t([1-9]\d*)$/i.exec(value.trim());
    if (!m) {
      return null;
    }
    const idx = parseInt(m[1], 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= this.pages.length) {
      return null;
    }
    return idx;
  }

  public setTabLabel(targetId: string, label: string | null): void {
    if (!this.pages.some((p) => p.targetId === targetId)) {
      throw new Error(`Tab not found: ${targetId}`);
    }
    if (!label || label.trim().length === 0) {
      this.tabLabels.delete(targetId);
      return;
    }

    const normalized = label.trim();
    const conflict = this.findTargetIdByLabel(normalized);
    if (conflict && conflict !== targetId) {
      throw new Error(`Tab label already exists: ${normalized}`);
    }
    this.tabLabels.set(targetId, normalized);
  }

  public findTargetIdByLabel(label: string): string | null {
    const normalized = label.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    for (const [targetId, existing] of this.tabLabels.entries()) {
      if (existing.toLowerCase() === normalized) {
        return targetId;
      }
    }
    return null;
  }

  public async syncTrackedTabs(): Promise<void> {
    const activeTargetId = this.getActivePage()?.targetId ?? null;
    const result = (await this.client.sendCommand('Target.getTargets', {})) as GetTargetsResult;
    const pageTargets = result.targetInfos.filter(shouldTrackTarget);
    const nextPages: PageInfo[] = [];

    for (const target of pageTargets) {
      const existing = this.pages.find((p) => p.targetId === target.targetId);
      if (existing) {
        existing.url = target.url;
        existing.title = target.title;
        existing.targetType = target.type;
        nextPages.push(existing);
        continue;
      }

      const attachResult = (await this.client.sendCommand('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })) as AttachToTargetResult;

      const page: PageInfo = {
        targetId: target.targetId,
        sessionId: attachResult.sessionId,
        url: target.url,
        title: target.title,
        targetType: target.type,
      };
      nextPages.push(page);
      await this.enableDomains(attachResult.sessionId);
    }

    this.pages = nextPages;
    this.pruneTabLabels();

    if (this.pages.length === 0) {
      this.activePageIndex = 0;
      await this.ensurePage();
      return;
    }

    if (activeTargetId) {
      const nextIdx = this.pages.findIndex((p) => p.targetId === activeTargetId);
      if (nextIdx >= 0) {
        this.activePageIndex = nextIdx;
        return;
      }
    }
    if (this.activePageIndex >= this.pages.length) {
      this.activePageIndex = this.pages.length - 1;
    }
  }

  private pruneTabLabels(): void {
    if (this.tabLabels.size === 0) {
      return;
    }
    const validTargets = new Set(this.pages.map((p) => p.targetId));
    for (const targetId of this.tabLabels.keys()) {
      if (!validTargets.has(targetId)) {
        this.tabLabels.delete(targetId);
      }
    }
  }
}

/**
 * Resolve a DevTools URL to a WebSocket URL.
 * Handles both full WebSocket URLs and HTTP URLs with /json/version endpoint.
 */
async function resolveDevToolsUrl(url: string): Promise<string> {
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return url;
  }

  const httpBaseRaw = url.startsWith('http://') || url.startsWith('https://')
    ? url
    : `http://${url}`;
  const httpBase = httpBaseRaw.replace(/\/+$/, '');
  const discoveryErrors: string[] = [];

  const fetchJson = async (endpoint: string): Promise<any | null> => {
    const endpointUrl = `${httpBase}${endpoint}`;
    try {
      const response = await fetch(endpointUrl);
      const text = await response.text();
      if (!text || text.trim().length === 0) {
        discoveryErrors.push(`${endpoint} returned empty response`);
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        discoveryErrors.push(`${endpoint} returned non-JSON payload (${reason})`);
        return null;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      discoveryErrors.push(`${endpoint} request failed (${reason})`);
      return null;
    }
  };

  const versionData = await fetchJson('/json/version');
  if (versionData?.webSocketDebuggerUrl) {
    return versionData.webSocketDebuggerUrl;
  }

  const listEndpoints = ['/json', '/json/list'];
  for (const endpoint of listEndpoints) {
    const targets = await fetchJson(endpoint);
    if (!Array.isArray(targets) || targets.length === 0) {
      continue;
    }

    const pageTarget = targets.find((t: any) => t?.type === 'page' && t?.webSocketDebuggerUrl);
    if (pageTarget?.webSocketDebuggerUrl) {
      return pageTarget.webSocketDebuggerUrl;
    }

    const anyTarget = targets.find((t: any) => t?.webSocketDebuggerUrl);
    if (anyTarget?.webSocketDebuggerUrl) {
      return anyTarget.webSocketDebuggerUrl;
    }
  }

  const wsBase = httpBase.startsWith('https://')
    ? `wss://${httpBase.slice('https://'.length)}`
    : `ws://${httpBase.replace(/^http:\/\//, '')}`;

  // Some CDP gateways disable JSON discovery but still expose direct WS paths.
  // Probe common candidates before failing.
  const wsCandidates = [
    `${wsBase}/devtools/browser`,
    `${wsBase}/devtools/page`,
  ];

  for (const candidate of wsCandidates) {
    try {
      const probe = await CdpClient.connect(candidate);
      probe.close();
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  const discoverySummary = discoveryErrors.length > 0
    ? discoveryErrors.join('; ')
    : 'no discoverable targets returned';

  throw new Error(
    `Failed to discover CDP endpoint: ${discoverySummary}. ` +
    'If your browser blocks /json discovery, connect with a full WebSocket URL, for example ' +
    '"ws://127.0.0.1:9222/devtools/browser/<id>".'
  );
}
