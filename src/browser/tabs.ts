import type { DaemonState } from './state.js';

function parseTabTarget(cmd: any): { index?: number; tabId?: string; label?: string } {
  if (typeof cmd.index === 'number' && !Number.isNaN(cmd.index)) {
    return { index: cmd.index };
  }
  if (typeof cmd.tabId === 'string' && cmd.tabId.trim().length > 0) {
    return { tabId: cmd.tabId.trim() };
  }
  if (typeof cmd.label === 'string' && cmd.label.trim().length > 0) {
    return { label: cmd.label.trim() };
  }
  return {};
}

function resolveTabTargetId(mgr: any, tabRef: string): string {
  const value = tabRef.trim();
  if (!value) {
    throw new Error('Tab not found: (empty)');
  }

  const pages = mgr.getPages?.() || [];
  const exact = pages.find((p: any) => p?.targetId === value);
  if (exact?.targetId) {
    return exact.targetId;
  }

  const byLabel = mgr.findTargetIdByLabel?.(value);
  if (typeof byLabel === 'string' && byLabel.length > 0) {
    return byLabel;
  }

  const lowered = value.toLowerCase();
  const prefixMatches = pages.filter((p: any) => {
    const targetId = typeof p?.targetId === 'string' ? p.targetId : '';
    return targetId.toLowerCase().startsWith(lowered);
  });

  if (prefixMatches.length === 1 && prefixMatches[0]?.targetId) {
    return prefixMatches[0].targetId;
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Tab id prefix is ambiguous: ${value} (${prefixMatches.length} matches)`);
  }

  throw new Error(`Tab not found: ${value}`);
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
      label: active ? mgr.tabList().find((t: any) => t.id === active.targetId)?.label : undefined,
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
  try {
    if (target.tabId) {
      mgr.setActivePageByTargetId(resolveTabTargetId(mgr, target.tabId));
    } else if (target.label) {
      mgr.setActivePageByTargetId(resolveTabTargetId(mgr, target.label));
    } else if (typeof target.index === 'number') {
      mgr.setActivePage(target.index);
    } else {
      return { id, success: false, error: 'Missing tab target. Use tab <label|tab-id>' };
    }
  } catch (error: any) {
    return { id, success: false, error: error?.message || 'Tab not found' };
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
      label: active ? mgr.tabList().find((t: any) => t.id === active.targetId)?.label : undefined,
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
  try {
    if (target.tabId) {
      await mgr.closePage(resolveTabTargetId(mgr, target.tabId));
    } else if (target.label) {
      await mgr.closePage(resolveTabTargetId(mgr, target.label));
    } else if (typeof target.index === 'number') {
      await mgr.closePageByIndex(target.index);
    } else {
      const active = mgr.getActivePage();
      if (!active) {
        return { id, success: false, error: 'No active tab to close' };
      }
      await mgr.closePage(active.targetId);
    }
  } catch (error: any) {
    return { id, success: false, error: error?.message || 'Tab not found' };
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
      label: active ? mgr.tabList().find((t: any) => t.id === active.targetId)?.label : undefined,
      title: active?.title || '',
      url: active?.url || '',
    },
  };
}
