import type { DaemonState } from './state.js';
import { clearCookies, getAllCookies, setCookies } from '../cdp/cookies.js';
import { setExtraHeaders, setOffline } from '../cdp/network.js';
import { storageClear, storageGet, storageSet } from '../cdp/storage.js';

function getSession(state: DaemonState): { mgr: any; sessionId: string } {
  const mgr = state.browser;
  if (!mgr) {
    throw new Error('Browser not launched');
  }
  return { mgr, sessionId: mgr.activeSessionId?.() || '' };
}

export async function handleCookiesGet(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const cookies = await getAllCookies(mgr.client, sessionId);
    return { id, success: true, data: { cookies } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleCookiesSet(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const name = String(cmd.name || '').trim();
    const value = cmd.value === undefined || cmd.value === null ? '' : String(cmd.value);
    if (!name) {
      return { id, success: false, error: 'Missing cookie name' };
    }
    const currentUrl = await mgr.getUrl().catch(() => undefined);
    await setCookies(mgr.client, sessionId, [{ name, value }], currentUrl);
    return { id, success: true, data: { set: true, name } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleCookiesClear(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    await clearCookies(mgr.client, sessionId);
    return { id, success: true, data: { cleared: true } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleStorageGet(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const type = cmd.type === 'session' ? 'session' : 'local';
    const key = typeof cmd.key === 'string' ? cmd.key : undefined;
    const data = await storageGet(mgr.client, sessionId, type, key);
    return { id, success: true, data };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleStorageSet(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const type = cmd.type === 'session' ? 'session' : 'local';
    const key = String(cmd.key || '').trim();
    if (!key) {
      return { id, success: false, error: 'Missing storage key' };
    }
    const value = cmd.value === undefined || cmd.value === null ? '' : String(cmd.value);
    await storageSet(mgr.client, sessionId, type, key, value);
    return { id, success: true, data: { set: true, key } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleStorageClear(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const type = cmd.type === 'session' ? 'session' : 'local';
    await storageClear(mgr.client, sessionId, type);
    return { id, success: true, data: { cleared: true, type } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleSetHeaders(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    let headers: Record<string, string>;
    if (typeof cmd.headers === 'string') {
      headers = JSON.parse(cmd.headers);
    } else if (cmd.headers && typeof cmd.headers === 'object') {
      headers = cmd.headers as Record<string, string>;
    } else {
      return { id, success: false, error: 'Missing headers JSON' };
    }
    await setExtraHeaders(mgr.client, sessionId, headers);
    return { id, success: true, data: { headers } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleSetOffline(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const offline = Boolean(cmd.offline);
    await setOffline(mgr.client, sessionId, offline);
    return { id, success: true, data: { offline } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}

export async function handleSetViewport(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  try {
    const { mgr, sessionId } = getSession(state);
    const width = Number(cmd.width);
    const height = Number(cmd.height);
    const deviceScaleFactor = cmd.deviceScaleFactor !== undefined ? Number(cmd.deviceScaleFactor) : 1;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { id, success: false, error: 'Invalid viewport width/height' };
    }
    await mgr.client.sendCommand(
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
      },
      sessionId
    );
    return { id, success: true, data: { width, height, deviceScaleFactor } };
  } catch (error: any) {
    return { id, success: false, error: error?.message || String(error) };
  }
}
