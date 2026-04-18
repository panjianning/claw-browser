import type { DaemonState } from './state.js';

function parseTabTarget(cmd: any): { index?: number; tabId?: string; shortId?: string; label?: string } {
  if (typeof cmd.index === 'number' && !Number.isNaN(cmd.index)) {
    return { index: cmd.index };
  }
  if (typeof cmd.tabId === 'string' && cmd.tabId.trim().length > 0) {
    return { tabId: cmd.tabId.trim() };
  }
  if (typeof cmd.shortId === 'string' && cmd.shortId.trim().length > 0) {
    return { shortId: cmd.shortId.trim() };
  }
  if (typeof cmd.label === 'string' && cmd.label.trim().length > 0) {
    return { label: cmd.label.trim() };
  }
  return {};
}

async function syncTabsIfSupported(mgr: any): Promise<void> {
  if (!mgr || typeof mgr.syncTrackedTabs !== 'function') {
    return;
  }
  try {
    await mgr.syncTrackedTabs();
  } catch {
    // Some direct CDP providers expose a page session without Target.*.
    // Keep local tab state in that mode.
  }
}

export async function handleTabList(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }
  await syncTabsIfSupported(mgr);
  return { id, success: true, data: { tabs: mgr.tabList() } };
}

export async function handleTabNew(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  await syncTabsIfSupported(mgr);
  const page = await mgr.createNewPage();
  mgr.setActivePageByTargetId(page.targetId);

  if (typeof cmd.url === 'string' && cmd.url.trim().length > 0) {
    await mgr.navigate(cmd.url);
  }
  if (typeof cmd.label === 'string' && cmd.label.trim().length > 0) {
    mgr.setTabLabel(page.targetId, cmd.label);
  }

  const active = mgr.getActivePage();
  const activeIndex = mgr.getPages().findIndex((p: any) => p.targetId === (active?.targetId || page.targetId));
  return {
    id,
    success: true,
    data: {
      created: true,
      tabId: active?.targetId || page.targetId,
      index: activeIndex,
      shortId: activeIndex >= 0 ? mgr.shortTabId(activeIndex) : undefined,
      label: active ? mgr.tabList().find((t) => t.id === active.targetId)?.label : undefined,
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

  await syncTabsIfSupported(mgr);
  const target = parseTabTarget(cmd);
  if (target.tabId) {
    mgr.setActivePageByTargetId(target.tabId);
  } else if (target.shortId) {
    mgr.setActivePageByShortId(target.shortId);
  } else if (target.label) {
    mgr.setActivePageByLabel(target.label);
  } else if (typeof target.index === 'number') {
    mgr.setActivePage(target.index);
  } else {
    return { id, success: false, error: 'Missing tab target. Use tab <tN|label|tab-id>' };
  }

  const active = mgr.getActivePage();
  const pages = mgr.getPages();
  const index = pages.findIndex((p: any) => p.targetId === active?.targetId);
  return {
    id,
    success: true,
    data: {
      switched: true,
      tabId: active?.targetId || '',
      index,
      shortId: index >= 0 ? mgr.shortTabId(index) : undefined,
      label: active ? mgr.tabList().find((t) => t.id === active.targetId)?.label : undefined,
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

  await syncTabsIfSupported(mgr);
  const target = parseTabTarget(cmd);
  if (target.tabId) {
    await mgr.closePage(target.tabId);
  } else if (target.shortId) {
    const idx = mgr.parseShortId(target.shortId);
    if (idx === null) {
      return { id, success: false, error: `Tab not found: ${target.shortId}` };
    }
    await mgr.closePageByIndex(idx);
  } else if (target.label) {
    const targetId = mgr.findTargetIdByLabel(target.label);
    if (!targetId) {
      return { id, success: false, error: `Tab label not found: ${target.label}` };
    }
    await mgr.closePage(targetId);
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

export async function handleWindowNew(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  await syncTabsIfSupported(mgr);
  const page = await mgr.createNewWindow();

  if (typeof cmd.url === 'string' && cmd.url.trim().length > 0) {
    await mgr.navigate(cmd.url);
  }
  if (typeof cmd.label === 'string' && cmd.label.trim().length > 0) {
    mgr.setTabLabel(page.targetId, cmd.label);
  }

  const active = mgr.getActivePage();
  const activeIndex = mgr.getPages().findIndex((p: any) => p.targetId === (active?.targetId || page.targetId));
  return {
    id,
    success: true,
    data: {
      created: true,
      window: true,
      tabId: active?.targetId || page.targetId,
      index: activeIndex,
      shortId: activeIndex >= 0 ? mgr.shortTabId(activeIndex) : undefined,
      label: active ? mgr.tabList().find((t) => t.id === active.targetId)?.label : undefined,
      title: active?.title || '',
      url: active?.url || '',
    },
  };
}
