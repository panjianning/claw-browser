import type { DaemonState } from './state.js';

/**
 * Navigation action handlers
 */

export async function handleNavigate(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const url = cmd.url;
  if (!url || typeof url !== 'string') {
    return { id, success: false, error: "Missing 'url' parameter" };
  }

  // Check domain filter
  if (state.domainFilter) {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      if (!state.domainFilter.isAllowed(domain)) {
        return {
          id,
          success: false,
          error: `Navigation blocked by domain filter: ${domain}`,
        };
      }
    } catch (e) {
      return { id, success: false, error: `Invalid URL: ${url}` };
    }
  }

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    await state.webdriverBackend.navigate(url);
    const newUrl = await state.webdriverBackend.getUrl().catch(() => url);
    state.refMap.clear();
    return { id, success: true, data: { url: newUrl } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const waitUntil = cmd.waitUntil || 'load';
  const waitUntilValue = waitUntil === 'commit' ? 'commit' : 'load';

  // Origin-scoped header injection
  const sessionId = mgr.activeSessionId?.() || '';
  if (state.originHeaders.size > 0) {
    try {
      const urlObj = new URL(url);
      const origin = urlObj.origin;
      const headers = state.originHeaders.get(origin);
      if (headers) {
        // Enable Fetch interception for header injection
        await mgr.client.sendCommand(
          'Fetch.enable',
          { patterns: [{ requestStage: 'Request' }] },
          sessionId
        );
      }
    } catch (e) {
      // Invalid URL, continue without headers
    }
  }

  await mgr.navigate(url, waitUntilValue);
  const newUrl = await mgr.getUrl().catch(() => url);
  const title = await mgr.getTitle().catch(() => '');
  state.refMap.clear();

  // Track visited origin for state persistence
  try {
    const urlObj = new URL(newUrl);
    const origin = urlObj.origin;
    if (origin !== 'null' && origin !== '') {
      state.visitedOrigins.add(origin);
    }
  } catch {
    // Invalid URL, skip tracking
  }

  return { id, success: true, data: { url: newUrl, title } };
}

export async function handleUrl(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    const url = await state.webdriverBackend.getUrl();
    return { id, success: true, data: { url } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const url = await mgr.getUrl();
  return { id, success: true, data: { url } };
}

export async function handleTitle(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const result = await mgr.client.sendCommand(
    'Target.getTargetInfo',
    { targetId: mgr.activeTargetId?.() || '' },
    undefined
  );

  const title = result?.targetInfo?.title || '';
  return { id, success: true, data: { title } };
}

export async function handleContent(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const result = await mgr.client.sendCommand(
    'Runtime.evaluate',
    {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    },
    sessionId
  );

  const html = result?.result?.value || '';
  return { id, success: true, data: { html } };
}

export async function handleBack(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    await state.webdriverBackend.back();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const url = await state.webdriverBackend.getUrl().catch(() => '');
    state.refMap.clear();
    return { id, success: true, data: { url } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  await mgr.evaluate('history.back()', undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const url = await mgr.getUrl().catch(() => '');
  state.refMap.clear();

  return { id, success: true, data: { url } };
}

export async function handleForward(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    await state.webdriverBackend.forward();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const url = await state.webdriverBackend.getUrl().catch(() => '');
    state.refMap.clear();
    return { id, success: true, data: { url } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  await mgr.evaluate('history.forward()', undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const url = await mgr.getUrl().catch(() => '');
  state.refMap.clear();

  return { id, success: true, data: { url } };
}

export async function handleReload(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    await state.webdriverBackend.reload();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const url = await state.webdriverBackend.getUrl().catch(() => '');
    state.refMap.clear();
    return { id, success: true, data: { url } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  await mgr.client.sendCommand('Page.reload', {}, sessionId);

  // Wait for load event
  const eventPromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 10000);
    const handler = (params: any, sid?: string) => {
      if (sid === sessionId) {
        clearTimeout(timeout);
        mgr.client.off('Page.loadEventFired', handler);
        resolve();
      }
    };
    mgr.client.on('Page.loadEventFired', handler);
  });

  await eventPromise;
  const url = await mgr.getUrl().catch(() => '');
  state.refMap.clear();

  return { id, success: true, data: { url } };
}
