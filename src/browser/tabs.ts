import type { DaemonState } from './state.js';

function parseTabTarget(cmd: any): { index?: number; tabId?: string } {
  if (typeof cmd.index === 'number' && !Number.isNaN(cmd.index)) {
    return { index: cmd.index };
  }
  if (typeof cmd.tabId === 'string' && cmd.tabId.trim().length > 0) {
    return { tabId: cmd.tabId.trim() };
  }
  return {};
}

export async function handleTabList(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }
  return { id, success: true, data: { tabs: mgr.tabList() } };
}

export async function handleTabNew(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const page = await mgr.createNewPage();
  mgr.setActivePageByTargetId(page.targetId);

  if (typeof cmd.url === 'string' && cmd.url.trim().length > 0) {
    await mgr.navigate(cmd.url);
  }

  const active = mgr.getActivePage();
  return {
    id,
    success: true,
    data: {
      created: true,
      tabId: active?.targetId || page.targetId,
      index: mgr.getPages().findIndex((p: any) => p.targetId === (active?.targetId || page.targetId)),
      title: active?.title || '',
      url: active?.url || '',
    },
  };
}

export async function handleTabSwitch(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const target = parseTabTarget(cmd);
  if (target.tabId) {
    mgr.setActivePageByTargetId(target.tabId);
  } else if (typeof target.index === 'number') {
    mgr.setActivePage(target.index);
  } else {
    return { id, success: false, error: 'Missing tab target. Use tab switch <index|tab-id>' };
  }

  const active = mgr.getActivePage();
  const pages = mgr.getPages();
  return {
    id,
    success: true,
    data: {
      switched: true,
      tabId: active?.targetId || '',
      index: pages.findIndex((p: any) => p.targetId === active?.targetId),
      title: active?.title || '',
      url: active?.url || '',
    },
  };
}

export async function handleTabClose(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const target = parseTabTarget(cmd);
  if (target.tabId) {
    await mgr.closePage(target.tabId);
  } else if (typeof target.index === 'number') {
    await mgr.closePageByIndex(target.index);
  } else {
    const active = mgr.getActivePage();
    if (!active) {
      return { id, success: false, error: 'No active tab to close' };
    }
    await mgr.closePage(active.targetId);
  }

  const active = mgr.getActivePage();
  return {
    id,
    success: true,
    data: {
      closed: true,
      activeTabId: active?.targetId || null,
    },
  };
}
