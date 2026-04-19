import type { DaemonState } from './state.js';
import { formatConsoleArgs } from '../cdp/network.js';
import { startHttpServer } from '../daemon/http-server.js';
import { startWebSocketServer } from '../daemon/ws-server.js';
import * as fs from 'fs/promises';
import * as path from 'path';

function ok(id: string, data: Record<string, unknown>): any {
  return { id, success: true, data };
}

function fail(id: string, error: string): any {
  return { id, success: false, error };
}

function getSession(state: DaemonState): { mgr: any; sessionId: string } {
  const mgr = state.browser;
  if (!mgr) {
    throw new Error('Browser not launched');
  }
  return { mgr, sessionId: mgr.activeSessionId?.() || '' };
}

function buildSelectorExpression(selector: string): string {
  if (selector.startsWith('xpath=')) {
    const xpath = selector.slice(6);
    return `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  return `document.querySelector(${JSON.stringify(selector)})`;
}

async function resolveObjectId(client: any, sessionId: string, selector: string): Promise<string> {
  const evalResult = await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: buildSelectorExpression(selector),
      returnByValue: false,
      awaitPromise: false,
    },
    sessionId
  );
  const objectId = evalResult?.result?.objectId;
  if (!objectId) {
    throw new Error(`Element not found: ${selector}`);
  }
  return objectId;
}

export async function handleFrame(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = String(cmd.selector || '').trim();
  if (!selector) {
    return fail(id, "Missing 'selector' parameter");
  }
  try {
    const { mgr, sessionId } = getSession(state);
    const objectId = await resolveObjectId(mgr.client, sessionId, selector);
    const describe = await mgr.client.sendCommand(
      'DOM.describeNode',
      { objectId, depth: 1 },
      sessionId
    );
    const frameId =
      describe?.node?.contentDocument?.frameId || describe?.node?.frameId || null;
    if (!frameId) {
      return fail(id, `Element is not an iframe/frame: ${selector}`);
    }
    state.activeFrameId = frameId;
    return ok(id, { frameId, selected: selector });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleMainFrame(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  state.activeFrameId = null;
  return ok(id, { frame: 'main' });
}

export async function handleSetContent(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const html = typeof cmd.html === 'string' ? cmd.html : '';
  if (!html) {
    return fail(id, "Missing 'html' parameter");
  }
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Runtime.evaluate',
      {
        expression: `document.open();document.write(${JSON.stringify(html)});document.close();`,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId
    );
    return ok(id, { contentSet: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleConsole(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const data = state.eventTracker.getConsoleJson();
  if (cmd.clear) {
    state.eventTracker.consoleEntries = [];
  }
  return ok(id, data);
}

export async function handleErrors(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const data = state.eventTracker.getErrorsJson();
  if (cmd.clear) {
    state.eventTracker.errorEntries = [];
  }
  return ok(id, data);
}

export async function handleRoute(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const pattern = String(cmd.pattern || '').trim();
  if (!pattern) {
    return fail(id, "Missing 'pattern' parameter");
  }

  const body = typeof cmd.body === 'string' ? cmd.body : null;
  const abort = cmd.abort === true;
  state.routes.push({
    urlPattern: pattern,
    abort,
    response: abort
      ? null
      : {
          status: typeof cmd.status === 'number' ? cmd.status : 200,
          body,
          contentType: null,
          headers: null,
        },
  });

  return ok(id, { routed: true, pattern, abort });
}

export async function handleUnroute(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const pattern = typeof cmd.pattern === 'string' ? cmd.pattern : '';
  if (!pattern) {
    const removed = state.routes.length;
    state.routes = [];
    return ok(id, { unrouted: true, removed });
  }
  const before = state.routes.length;
  state.routes = state.routes.filter((r) => r.urlPattern !== pattern);
  return ok(id, { unrouted: true, removed: before - state.routes.length, pattern });
}

export async function handleNetworkRequests(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const filter = typeof cmd.filter === 'string' ? cmd.filter.toLowerCase() : '';
  const method = typeof cmd.method === 'string' ? cmd.method.toUpperCase() : '';
  const resourceType = typeof cmd.resourceType === 'string' ? cmd.resourceType : '';
  const status = cmd.status !== undefined ? Number(cmd.status) : undefined;

  let requests = [...state.trackedRequests];
  if (filter) requests = requests.filter((r) => r.url.toLowerCase().includes(filter));
  if (method) requests = requests.filter((r) => String(r.method).toUpperCase() === method);
  if (resourceType) requests = requests.filter((r) => r.resourceType === resourceType);
  if (!Number.isNaN(status as number) && status !== undefined) {
    requests = requests.filter((r) => r.status === status);
  }

  return ok(id, { requests });
}

export async function handleNetworkRequest(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const requestId = String(cmd.requestId || '').trim();
  if (!requestId) return fail(id, "Missing 'requestId' parameter");
  const request = state.trackedRequests.find((r) => r.requestId === requestId);
  if (!request) return fail(id, `Request not found: ${requestId}`);
  return ok(id, { request });
}

export async function handleResponseBody(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const requestId = String(cmd.requestId || '').trim();
  if (!requestId) return fail(id, "Missing 'requestId' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    const res = await mgr.client.sendCommand('Network.getResponseBody', { requestId }, sessionId);
    const body = res?.base64Encoded ? Buffer.from(res.body || '', 'base64').toString('utf-8') : (res?.body || '');
    return ok(id, { requestId, body, base64Encoded: Boolean(res?.base64Encoded) });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleUserAgent(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const userAgent = String(cmd.userAgent || '').trim();
  if (!userAgent) return fail(id, "Missing 'userAgent' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Network.setUserAgentOverride', { userAgent }, sessionId);
    return ok(id, { userAgent });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleSetMedia(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const colorScheme = typeof cmd.colorScheme === 'string' ? cmd.colorScheme : 'light';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Emulation.setEmulatedMedia',
      {
        media: 'screen',
        features: [{ name: 'prefers-color-scheme', value: colorScheme }],
      },
      sessionId
    );
    return ok(id, { colorScheme });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleTimezone(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const timezoneId = String(cmd.timezoneId || '').trim();
  if (!timezoneId) return fail(id, "Missing 'timezoneId' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Emulation.setTimezoneOverride', { timezoneId }, sessionId);
    return ok(id, { timezoneId });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleLocale(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const locale = String(cmd.locale || '').trim();
  if (!locale) return fail(id, "Missing 'locale' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Emulation.setLocaleOverride', { locale }, sessionId);
    return ok(id, { locale });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleGeolocation(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const latitude = Number(cmd.latitude);
  const longitude = Number(cmd.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return fail(id, 'Invalid latitude/longitude');
  }
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Emulation.setGeolocationOverride',
      { latitude, longitude, accuracy: 100 },
      sessionId
    );
    return ok(id, { latitude, longitude });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handlePermissions(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const permissions = Array.isArray(cmd.permissions) ? cmd.permissions.map(String) : [];
  if (permissions.length === 0) {
    return fail(id, "Missing 'permissions' parameter");
  }
  try {
    const { mgr, sessionId } = getSession(state);
    const origin = await mgr.getUrl().catch(() => 'https://example.com');
    await mgr.client.sendCommand(
      'Browser.grantPermissions',
      { permissions, origin },
      sessionId
    );
    return ok(id, { permissions, origin });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleDialog(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const op = String(cmd.op || 'status');
  try {
    const { mgr, sessionId } = getSession(state);
    if (op === 'status') {
      const d = state.pendingDialog;
      return ok(id, {
        hasDialog: Boolean(d),
        type: d?.dialogType || null,
        message: d?.message || null,
        defaultPrompt: d?.defaultPrompt || null,
      });
    }
    if (op === 'accept' || op === 'dismiss') {
      await mgr.client.sendCommand(
        'Page.handleJavaScriptDialog',
        { accept: op === 'accept', promptText: typeof cmd.text === 'string' ? cmd.text : undefined },
        sessionId
      );
      state.pendingDialog = null;
      return ok(id, { handled: true, op });
    }
    return fail(id, `Unsupported dialog op: ${op}`);
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleBringToFront(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Page.bringToFront', {}, sessionId);
    return ok(id, { broughtToFront: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleInspect(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr } = getSession(state);
    const cdp = typeof mgr.getCdpUrl === 'function' ? mgr.getCdpUrl() : '';
    return ok(id, { opened: false, url: cdp, note: 'Use this CDP URL in Chrome DevTools manually' });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleSessionStatus(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const defaultHeaded = process.env.CLAW_BROWSER_HEADED === '1';
  const configuredCdpTarget = (process.env.CLAW_BROWSER_CDP || '').trim() || null;
  const configuredProfile = (process.env.CLAW_BROWSER_PROFILE || '').trim() || null;
  const browser = state.browser;

  let cdpConnected = false;
  let cdpUrl: string | null = null;
  if (browser) {
    try {
      cdpConnected = Boolean(await browser.isConnectionAlive?.());
    } catch {
      cdpConnected = false;
    }
    try {
      cdpUrl = typeof browser.getCdpUrl === 'function' ? String(browser.getCdpUrl()) : null;
    } catch {
      cdpUrl = null;
    }
  }

  const mode = !browser
    ? 'idle'
    : state.backendType === 'webdriver'
      ? 'webdriver'
      : state.isCdpConnection
        ? 'external-cdp'
        : 'managed-browser';

  const headed =
    state.launchHeadless === null
      ? null
      : !state.launchHeadless;
  const startedAt = new Date(state.startedAtMs).toISOString();
  const uptimeMs = Math.max(0, Date.now() - state.startedAtMs);

  return ok(id, {
    session: state.sessionId,
    daemonPid: process.pid,
    startedAt,
    uptimeMs,
    mode,
    backendType: state.backendType,
    engine: state.engine,
    browserLaunched: Boolean(browser),
    cdpConnected,
    cdpUrl,
    externalTarget: state.externalTargetKey,
    headed,
    launchHeadless: state.launchHeadless,
    profile: state.launchProfile,
    config: {
      defaultHeaded,
      configuredCdpTarget,
      configuredProfile,
    },
  });
}

export async function handlePdf(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const outPath = String(cmd.path || '').trim();
  if (!outPath) {
    return fail(id, "Missing 'path' parameter");
  }
  try {
    const { mgr, sessionId } = getSession(state);
    const result = await mgr.client.sendCommand('Page.printToPDF', { printBackground: true }, sessionId);
    const pdfBase64 = result?.data || '';
    const buffer = Buffer.from(pdfBase64, 'base64');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, buffer);
    return ok(id, { path: outPath });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

const DEVICE_PRESETS: Record<string, { width: number; height: number; scale: number; mobile: boolean; userAgent?: string }> = {
  'iphone 15 pro': { width: 393, height: 852, scale: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'iphone 14': { width: 390, height: 844, scale: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'pixel 7': { width: 412, height: 915, scale: 2.625, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'ipad': { width: 810, height: 1080, scale: 2, mobile: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'desktop': { width: 1280, height: 720, scale: 1, mobile: false },
};

export async function handleDevice(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const raw = String(cmd.name || '').trim().toLowerCase();
  if (!raw) return fail(id, "Missing 'name' parameter");
  const preset = DEVICE_PRESETS[raw];
  if (!preset) {
    return fail(id, `Unknown device preset: ${cmd.name}`);
  }
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Emulation.setDeviceMetricsOverride',
      {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.scale,
        mobile: preset.mobile,
      },
      sessionId
    );
    if (preset.userAgent) {
      await mgr.client.sendCommand('Network.setUserAgentOverride', { userAgent: preset.userAgent }, sessionId);
    }
    return ok(id, { device: cmd.name, width: preset.width, height: preset.height, mobile: preset.mobile });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleDownload(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = String(cmd.selector || '').trim();
  const outPath = String(cmd.path || '').trim();
  if (!selector || !outPath) {
    return fail(id, "Missing 'selector' or 'path' parameter");
  }
  try {
    const { mgr, sessionId } = getSession(state);
    const objectId = await resolveObjectId(mgr.client, sessionId, selector);
    const point = await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(){ const r=this.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; }`,
        returnByValue: true,
      },
      sessionId
    );
    const x = Number(point?.result?.value?.x || 0);
    const y = Number(point?.result?.value?.y || 0);
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    return ok(id, { started: true, path: outPath, note: 'Browser download triggered; move/rename is managed by browser download settings' });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleStreamEnable(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  if (state.streamServer) {
    return ok(id, { enabled: true, port: (state as any).streamPort || null, connected: true, screencasting: state.screencasting });
  }
  try {
    const httpServer = await startHttpServer(state, typeof cmd.port === 'number' ? cmd.port : undefined);
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : null;
    const wsServer = await startWebSocketServer(state, httpServer);
    state.streamServer = wsServer;
    (state as any).streamHttpServer = httpServer;
    (state as any).streamPort = port;
    return ok(id, { enabled: true, port, connected: true, screencasting: state.screencasting });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleStreamDisable(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    if (state.streamServer) {
      state.streamServer.close();
      state.streamServer = null;
    }
    const httpServer = (state as any).streamHttpServer;
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      (state as any).streamHttpServer = null;
    }
    (state as any).streamPort = null;
    return ok(id, { disabled: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleStreamStatus(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  return ok(id, {
    enabled: Boolean(state.streamServer),
    port: (state as any).streamPort || null,
    connected: Boolean(state.browser),
    screencasting: state.screencasting,
  });
}

export async function handleScreencastStart(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Page.startScreencast',
      { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
      sessionId
    );
    state.screencasting = true;
    return ok(id, { screencasting: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleScreencastStop(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Page.stopScreencast', {}, sessionId);
    state.screencasting = false;
    return ok(id, { screencasting: false });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

function escapeXpathText(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  const parts = text.split("'");
  return `concat(${parts.map((p, i) => `${i > 0 ? `,"'",` : ''}'${p}'`).join('')})`;
}

function selectorFromFind(kind: string, query: string): string {
  switch (kind) {
    case 'role':
      return `[role="${query}"]`;
    case 'label':
      return `xpath=//*[self::label or @aria-label][contains(normalize-space(.), ${escapeXpathText(query)}) or contains(@aria-label, ${escapeXpathText(query)})]`;
    case 'text':
      return `xpath=//*[contains(normalize-space(.), ${escapeXpathText(query)})]`;
    case 'placeholder':
      return `[placeholder*="${query}"]`;
    case 'alt':
      return `[alt*="${query}"]`;
    case 'title':
      return `[title*="${query}"]`;
    case 'testid':
      return `[data-testid="${query}"],[data-test-id="${query}"]`;
    default:
      return query;
  }
}

export async function handleFind(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const kind = String(cmd.kind || '').trim();
  const query = String(cmd.query || '').trim();
  const action = String(cmd.findAction || '').trim();
  const value = cmd.value;
  if (!kind || !query || !action) {
    return fail(id, "find requires kind, query, action");
  }

  const selector = selectorFromFind(kind, query);
  try {
    const { mgr, sessionId } = getSession(state);
    if (action === 'count') {
      const res = await mgr.client.sendCommand(
        'Runtime.evaluate',
        { expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`, returnByValue: true },
        sessionId
      );
      return ok(id, { selector, count: res?.result?.value || 0 });
    }
    if (action === 'click') {
      const objectId = await resolveObjectId(mgr.client, sessionId, selector);
      const point = await mgr.client.sendCommand(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function(){ const r=this.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; }`,
          returnByValue: true,
        },
        sessionId
      );
      const x = Number(point?.result?.value?.x || 0);
      const y = Number(point?.result?.value?.y || 0);
      await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
      await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
      await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
      return ok(id, { selector, clicked: true });
    }
    if (action === 'fill' || action === 'type') {
      const objectId = await resolveObjectId(mgr.client, sessionId, selector);
      const text = String(value ?? '');
      await mgr.client.sendCommand(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function(v){ if(this.focus) this.focus(); if('value' in this) this.value=v; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }`,
          arguments: [{ value: text }],
        },
        sessionId
      );
      return ok(id, { selector, [action === 'fill' ? 'filled' : 'typed']: text });
    }
    if (action === 'gettext') {
      const objectId = await resolveObjectId(mgr.client, sessionId, selector);
      const textRes = await mgr.client.sendCommand(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: "function(){return this.innerText||this.textContent||'';}", returnByValue: true },
        sessionId
      );
      return ok(id, { selector, text: textRes?.result?.value || '' });
    }
    return fail(id, `Unsupported find action: ${action}`);
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleHighlight(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = String(cmd.selector || '').trim();
  if (!selector) return fail(id, "Missing 'selector' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    const objectId = await resolveObjectId(mgr.client, sessionId, selector);
    await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(){ this.style.outline='2px solid #ff0000'; this.style.outlineOffset='2px'; }`,
      },
      sessionId
    );
    return ok(id, { highlighted: selector });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleSelectAll(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Runtime.evaluate', { expression: 'document.execCommand("selectAll")' }, sessionId);
    return ok(id, { selectedAll: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleClipboard(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const op = String(cmd.op || '').trim().toLowerCase();
  try {
    const { mgr, sessionId } = getSession(state);
    if (op === 'read') {
      const res = await mgr.client.sendCommand(
        'Runtime.evaluate',
        { expression: '(async()=>await navigator.clipboard.readText())()', awaitPromise: true, returnByValue: true },
        sessionId
      );
      return ok(id, { text: res?.result?.value || '' });
    }
    if (op === 'write') {
      const text = String(cmd.text || '');
      await mgr.client.sendCommand(
        'Runtime.evaluate',
        { expression: `(async()=>{await navigator.clipboard.writeText(${JSON.stringify(text)});return true;})()`, awaitPromise: true, returnByValue: true },
        sessionId
      );
      return ok(id, { written: true });
    }
    return fail(id, `Unsupported clipboard op: ${op}`);
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleGetBy(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const action = String(cmd.action || '');
  const query = String(cmd.query || cmd.selector || '').trim();
  if (!query) return fail(id, 'Missing query');
  let selector = '';
  if (action === 'getbyrole') selector = `[role="${query}"]`;
  if (action === 'getbytext') selector = `xpath=//*[contains(normalize-space(.), ${escapeXpathText(query)})]`;
  if (action === 'getbylabel') selector = `xpath=//*[self::label or @aria-label][contains(normalize-space(.), ${escapeXpathText(query)}) or contains(@aria-label, ${escapeXpathText(query)})]`;
  if (action === 'getbyplaceholder') selector = `[placeholder*="${query}"]`;
  if (action === 'getbyalttext') selector = `[alt*="${query}"]`;
  if (action === 'getbytitle') selector = `[title*="${query}"]`;
  if (action === 'getbytestid') selector = `[data-testid="${query}"],[data-test-id="${query}"]`;
  if (!selector) return fail(id, `Unsupported getby action: ${action}`);
  return ok(id, { selector });
}

export async function handleNth(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = String(cmd.selector || '').trim();
  const index = Number(cmd.index ?? cmd.n ?? 0);
  if (!selector || !Number.isFinite(index) || index < 0) {
    return fail(id, 'Invalid selector/index');
  }
  return ok(id, { selector: `xpath=(${selector})[${Math.floor(index) + 1}]` });
}

export async function handleHarStart(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  state.harRecording = true;
  state.harEntries = [];
  return ok(id, { started: true });
}

export async function handleHarStop(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  state.harRecording = false;
  const outPath = typeof cmd.path === 'string' && cmd.path.trim().length > 0
    ? cmd.path
    : path.join(process.cwd(), `har-${Date.now()}.json`);
  const log = {
    log: {
      version: '1.2',
      creator: { name: 'claw-browser', version: '0.1.0' },
      entries: state.trackedRequests.map((r) => ({
        startedDateTime: new Date(r.timestamp).toISOString(),
        request: { method: r.method, url: r.url, headers: [] },
        response: { status: r.status || 0, headers: [], content: { mimeType: r.mimeType || '', size: 0 } },
      })),
    },
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(log, null, 2), 'utf-8');
  return ok(id, { stopped: true, path: outPath });
}

export async function handleDispatch(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = String(cmd.selector || '').trim();
  const event = String(cmd.event || cmd.type || '').trim();
  if (!selector || !event) return fail(id, "Missing 'selector' or 'event'");
  try {
    const { mgr, sessionId } = getSession(state);
    const objectId = await resolveObjectId(mgr.client, sessionId, selector);
    await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(ev){ this.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true })); }`,
        arguments: [{ value: event }],
      },
      sessionId
    );
    return ok(id, { dispatched: true, event, selector });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleAddScript(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const script = String(cmd.script || '').trim();
  if (!script) return fail(id, "Missing 'script' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Runtime.evaluate', { expression: script, awaitPromise: true }, sessionId);
    return ok(id, { executed: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleAddInitScript(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const script = String(cmd.script || '').trim();
  if (!script) return fail(id, "Missing 'script' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    const result = await mgr.client.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: script }, sessionId);
    return ok(id, { identifier: result?.identifier || null });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleAddStyle(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const css = String(cmd.css || cmd.style || '').trim();
  if (!css) return fail(id, "Missing 'css' parameter");
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Runtime.evaluate',
      {
        expression: `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.documentElement.appendChild(s);return true;})()`,
        returnByValue: true,
      },
      sessionId
    );
    return ok(id, { injected: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleDeviceList(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  return ok(id, { devices: Object.keys(DEVICE_PRESETS) });
}

export async function handlePause(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const ms = Number(cmd.timeout || cmd.ms || 1000);
  await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 1000));
  return ok(id, { paused: true, ms: Number.isFinite(ms) ? ms : 1000 });
}

export async function handleConfirm(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const pending = state.pendingConfirmation;
  if (!pending) return fail(id, 'No pending confirmation');
  state.pendingConfirmation = null;
  const { executeCommand } = await import('./executor.js');
  return executeCommand(pending.cmd, state);
}

export async function handleDeny(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const pending = state.pendingConfirmation;
  if (!pending) return fail(id, 'No pending confirmation');
  state.pendingConfirmation = null;
  return ok(id, { denied: true, action: pending.action });
}

export async function handleTap(cmd: any, state: DaemonState): Promise<any> {
  // Reuse click semantics for desktop CDP backend.
  const { handleClick } = await import('./interactions.js');
  return handleClick(cmd, state);
}

export async function handleTraceStart(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand(
      'Tracing.start',
      {
        categories: 'devtools.timeline,v8.execute',
        options: 'sampling-frequency=10000',
      },
      sessionId
    );
    state.tracingState.tracing = true;
    state.tracingState.tracePath = typeof cmd.path === 'string' ? cmd.path : null;
    return ok(id, { tracing: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleTraceStop(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    if (state.tracingState.tracing) {
      await mgr.client.sendCommand('Tracing.end', {}, sessionId);
    }
    state.tracingState.tracing = false;
    return ok(id, { tracing: false, path: state.tracingState.tracePath });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleProfilerStart(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await mgr.client.sendCommand('Profiler.enable', {}, sessionId);
    await mgr.client.sendCommand('Profiler.start', {}, sessionId);
    return ok(id, { profiling: true });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleProfilerStop(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const result = await mgr.client.sendCommand('Profiler.stop', {}, sessionId);
    await mgr.client.sendCommand('Profiler.disable', {}, sessionId).catch(() => {});
    const outPath = typeof cmd.path === 'string' && cmd.path.trim().length > 0 ? cmd.path : '';
    if (outPath) {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(result?.profile || {}, null, 2), 'utf-8');
    }
    return ok(id, { profiling: false, path: outPath || null });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleRecordingStart(cmd: any, state: DaemonState): Promise<any> {
  return handleScreencastStart(cmd, state);
}

export async function handleRecordingStop(cmd: any, state: DaemonState): Promise<any> {
  return handleScreencastStop(cmd, state);
}

export async function handleVideoStart(cmd: any, state: DaemonState): Promise<any> {
  return handleScreencastStart(cmd, state);
}

export async function handleVideoStop(cmd: any, state: DaemonState): Promise<any> {
  return handleScreencastStop(cmd, state);
}

export function bindRuntimeEventTrackers(state: DaemonState): void {
  const client = state.browser?.client;
  if (!client) return;
  const marker = '__ab_event_tracker_bound';
  if ((client as any)[marker]) return;
  (client as any)[marker] = true;

  client.on('Runtime.consoleAPICalled', (params: any) => {
    const level = params?.type || 'log';
    const text = formatConsoleArgs(params?.args || []);
    const frameUrl = params?.stackTrace?.callFrames?.[0]?.url;
    const lineNumber = params?.stackTrace?.callFrames?.[0]?.lineNumber;
    state.eventTracker.addConsole(level, text, params?.args || [], frameUrl, lineNumber);
  });

  client.on('Runtime.exceptionThrown', (params: any) => {
    const details = params?.exceptionDetails || {};
    const text = details?.text || details?.exception?.description || 'JavaScript exception';
    state.eventTracker.addError(text, details?.url, details?.lineNumber, details?.columnNumber);
  });

  client.on('Network.requestWillBeSent', (params: any) => {
    const req = params?.request || {};
    state.trackedRequests.push({
      url: req.url || '',
      method: req.method || 'GET',
      headers: req.headers || {},
      timestamp: Date.now(),
      resourceType: params?.type || '',
      requestId: params?.requestId || '',
      postData: req.postData,
    });
    if (state.trackedRequests.length > 1000) {
      state.trackedRequests.splice(0, state.trackedRequests.length - 1000);
    }
  });

  client.on('Network.responseReceived', (params: any) => {
    const requestId = params?.requestId;
    if (!requestId) return;
    const resp = params?.response || {};
    const target = state.trackedRequests.find((r) => r.requestId === requestId);
    if (!target) return;
    target.status = typeof resp.status === 'number' ? resp.status : undefined;
    target.responseHeaders = resp.headers || {};
    target.mimeType = resp.mimeType || '';
  });

  client.on('Page.javascriptDialogOpening', (params: any) => {
    state.pendingDialog = {
      dialogType: params?.type || 'alert',
      message: params?.message || '',
      url: params?.url || '',
      defaultPrompt: params?.defaultPrompt || null,
    };
  });

  client.on('Page.javascriptDialogClosed', () => {
    state.pendingDialog = null;
  });
}
