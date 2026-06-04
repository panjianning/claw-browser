export function commandSessionId(cmd: any, mgr: any): string {
  if (typeof cmd?.sessionId === 'string' && cmd.sessionId.trim().length > 0) {
    return cmd.sessionId.trim();
  }
  return mgr?.activeSessionId?.() || '';
}

export function commandTabId(cmd: any, mgr: any): string {
  if (typeof cmd?.tabId === 'string' && cmd.tabId.trim().length > 0) {
    return cmd.tabId.trim();
  }
  return mgr?.activeTargetId?.() || '';
}
