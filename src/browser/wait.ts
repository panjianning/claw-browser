import type { DaemonState } from './state.js';
import type { CdpClient } from '../cdp/client.js';

/**
 * Wait operation handlers
 */

export async function handleWait(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = getWaitSessionId(cmd, mgr);
  const timeoutMs = state.timeoutMs(cmd);

  // Wait for text
  if (cmd.text && typeof cmd.text === 'string') {
    await waitForText(mgr.client, sessionId, cmd.text, timeoutMs);
    return { id, success: true, data: { waited: 'text', text: cmd.text } };
  }

  // Wait for selector
  if (cmd.selector && typeof cmd.selector === 'string') {
    const selectorState = cmd.state || 'visible';
    await waitForSelector(
      mgr.client,
      sessionId,
      cmd.selector,
      selectorState,
      timeoutMs
    );
    return {
      id,
      success: true,
      data: { waited: 'selector', selector: cmd.selector },
    };
  }

  // Wait for URL pattern
  if (cmd.url && typeof cmd.url === 'string') {
    await waitForUrl(mgr.client, sessionId, cmd.url, timeoutMs);
    return { id, success: true, data: { waited: 'url', url: cmd.url } };
  }

  // Wait for function
  if (cmd.function && typeof cmd.function === 'string') {
    await waitForFunction(mgr.client, sessionId, cmd.function, timeoutMs);
    return { id, success: true, data: { waited: 'function' } };
  }

  // Wait for load state
  if (cmd.loadState && typeof cmd.loadState === 'string') {
    const waitUntil = normalizeWaitUntil(cmd.loadState);
    await waitForLifecycleWithTimeout(mgr, sessionId, waitUntil, timeoutMs);
    return {
      id,
      success: true,
      data: { waited: 'load', state: cmd.loadState },
    };
  }

  // Just a timeout wait
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return { id, success: true, data: { waited: 'timeout', ms: timeoutMs } };
}

export async function handleWaitForUrl(
  cmd: any,
  state: DaemonState
): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const urlPattern = cmd.url;
  if (!urlPattern || typeof urlPattern !== 'string') {
    return { id, success: false, error: "Missing 'url' parameter" };
  }

  const sessionId = getWaitSessionId(cmd, mgr);
  const timeoutMs = state.timeoutMs(cmd);

  await waitForUrl(mgr.client, sessionId, urlPattern, timeoutMs);
  const url = await mgr.getUrl().catch(() => '');
  return { id, success: true, data: { url } };
}

export async function handleWaitForLoadState(
  cmd: any,
  state: DaemonState
): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const loadState = normalizeWaitUntil(cmd.state || 'load');
  const sessionId = getWaitSessionId(cmd, mgr);
  const timeoutMs = state.timeoutMs(cmd);
  try {
    await waitForLifecycleWithTimeout(mgr, sessionId, loadState, timeoutMs);
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }

  return { id, success: true, data: { state: loadState } };
}

export async function handleWaitForFunction(
  cmd: any,
  state: DaemonState
): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const expression = cmd.expression;
  if (!expression || typeof expression !== 'string') {
    return { id, success: false, error: "Missing 'expression' parameter" };
  }

  const sessionId = getWaitSessionId(cmd, mgr);
  const timeoutMs = state.timeoutMs(cmd);

  await waitForFunction(mgr.client, sessionId, expression, timeoutMs);

  // Return the result of the expression
  const result = await mgr.client.sendCommand<any>(
    'Runtime.evaluate',
    {
      expression: `(${expression})`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId
  );

  return {
    id,
    success: true,
    data: { result: result?.result?.value || null },
  };
}

export async function handleWaitForDownload(
  cmd: any,
  state: DaemonState
): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = getWaitSessionId(cmd, mgr);
  const timeoutMs = state.timeoutMs(cmd);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const handler = (params: any, sid?: string) => {
      const isPageSession = sid === sessionId;
      const isProgress =
        params.method === 'Browser.downloadProgress' ||
        (params.method === 'Page.downloadProgress' && isPageSession);

      if (
        isProgress &&
        params.params?.state === 'completed'
      ) {
        mgr.client.off('Browser.downloadProgress', handler);
        mgr.client.off('Page.downloadProgress', handler);
        const path = cmd.path || 'download';
        resolve({ id, success: true, data: { path } });
      }
    };

    mgr.client.on('Browser.downloadProgress', handler);
    mgr.client.on('Page.downloadProgress', handler);

    // Timeout handling
    const checkTimeout = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(checkTimeout);
        mgr.client.off('Browser.downloadProgress', handler);
        mgr.client.off('Page.downloadProgress', handler);
        resolve({
          id,
          success: false,
          error: 'Timeout waiting for download',
        });
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

async function waitForSelector(
  client: CdpClient,
  sessionId: string,
  selector: string,
  state: string,
  timeoutMs: number
): Promise<void> {
  let checkFn: string;

  switch (state) {
    case 'attached':
      checkFn = `!!document.querySelector(${JSON.stringify(selector)})`;
      break;
    case 'detached':
      checkFn = `!document.querySelector(${JSON.stringify(selector)})`;
      break;
    case 'hidden':
      checkFn = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return true;
        const s = window.getComputedStyle(el);
        return s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0;
      })()`;
      break;
    default: // 'visible'
      checkFn = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      })()`;
      break;
  }

  await pollUntilTrue(client, sessionId, checkFn, timeoutMs);
}

async function waitForUrl(
  client: CdpClient,
  sessionId: string,
  pattern: string,
  timeoutMs: number
): Promise<void> {
  const checkFn = `location.href.includes(${JSON.stringify(pattern)})`;
  await pollUntilTrue(client, sessionId, checkFn, timeoutMs);
}

async function waitForText(
  client: CdpClient,
  sessionId: string,
  text: string,
  timeoutMs: number
): Promise<void> {
  const checkFn = `(document.body.innerText || '').includes(${JSON.stringify(
    text
  )})`;
  await pollUntilTrue(client, sessionId, checkFn, timeoutMs);
}

async function waitForFunction(
  client: CdpClient,
  sessionId: string,
  fnStr: string,
  timeoutMs: number
): Promise<void> {
  const checkFn = `!!(${fnStr})`;
  await pollUntilTrue(client, sessionId, checkFn, timeoutMs);
}

async function pollUntilTrue(
  client: CdpClient,
  sessionId: string,
  expression: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await client.sendCommand<any>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId
    );

    if (result?.result?.value === true) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Wait timed out after ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForEvent(
  client: CdpClient,
  sessionId: string,
  eventName: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeoutMs);

    const handler = (_params: any, sid?: string) => {
      if (!sid || sid === sessionId) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      client.off(eventName, handler);
    };

    client.on(eventName, handler);
  });
}

function getWaitSessionId(cmd: any, mgr: any): string {
  if (cmd && typeof cmd.sessionId === 'string' && cmd.sessionId.length > 0) {
    return cmd.sessionId;
  }
  return mgr.activeSessionId?.() || '';
}

function normalizeWaitUntil(raw: string): string {
  const value = String(raw || 'load').trim().toLowerCase();
  if (value === 'domcontentloaded') return 'domcontentloaded';
  if (value === 'networkidle') return 'networkidle';
  if (value === 'none') return 'none';
  // commit is not implemented as a separate lifecycle signal in this backend.
  if (value === 'commit') return 'load';
  return 'load';
}

async function waitForLifecycleWithTimeout(
  mgr: any,
  sessionId: string,
  waitUntil: string,
  timeoutMs: number
): Promise<void> {
  const previousTimeout =
    typeof mgr.getDefaultTimeoutMs === 'function' ? mgr.getDefaultTimeoutMs() : undefined;
  const canSetDefaultTimeout = typeof mgr.setDefaultTimeout === 'function';

  if (canSetDefaultTimeout) {
    mgr.setDefaultTimeout(timeoutMs);
  }

  try {
    if (typeof mgr.waitForLifecycle === 'function') {
      await mgr.waitForLifecycle(waitUntil, sessionId);
      return;
    }

    if (waitUntil === 'networkidle') {
      throw new Error('networkidle wait is not supported by this browser manager');
    }

    const eventName =
      waitUntil === 'domcontentloaded'
        ? 'Page.domContentEventFired'
        : 'Page.loadEventFired';
    await waitForEvent(mgr.client, sessionId, eventName, timeoutMs);
  } finally {
    if (
      canSetDefaultTimeout &&
      typeof previousTimeout === 'number' &&
      Number.isFinite(previousTimeout) &&
      previousTimeout > 0
    ) {
      mgr.setDefaultTimeout(previousTimeout);
    }
  }
}
