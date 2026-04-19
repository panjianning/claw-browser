import type { DaemonState } from './state.js';

function parseShortTabIndex(value: string): number | null {
  const m = /^t([1-9]\d*)$/i.exec(value.trim());
  if (!m) {
    return null;
  }
  const idx = parseInt(m[1], 10) - 1;
  return Number.isNaN(idx) || idx < 0 ? null : idx;
}

function resolveTabIdReference(browser: any, tabRef: string): string {
  const value = tabRef.trim();
  if (!value) {
    throw new Error('Tab not found: (empty)');
  }

  const pages = browser.getPages?.() || [];
  const exact = pages.find((p: any) => p?.targetId === value);
  if (exact?.targetId) {
    return exact.targetId;
  }

  const shortIndex = parseShortTabIndex(value);
  if (shortIndex !== null) {
    const byShort = pages[shortIndex];
    if (byShort?.targetId) {
      return byShort.targetId;
    }
    throw new Error(`Tab not found: ${value}`);
  }

  const byLabel = browser.findTargetIdByLabel?.(value);
  if (typeof byLabel === 'string' && byLabel.length > 0) {
    return byLabel;
  }

  // Accept unique targetId prefix to make --tab-id easier to use in CLI.
  const lowered = value.toLowerCase();
  const prefixMatches = pages.filter((p: any) => {
    const targetId = typeof p?.targetId === 'string' ? p.targetId : '';
    return targetId.toLowerCase().startsWith(lowered);
  });

  if (prefixMatches.length === 1 && prefixMatches[0]?.targetId) {
    return prefixMatches[0].targetId;
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Tab id prefix is ambiguous: ${value} (${prefixMatches.length} matches)`
    );
  }

  throw new Error(`Tab not found: ${value}`);
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Create a success response.
 */
export function successResponse(id: string, data: any): any {
  return {
    id,
    success: true,
    data,
  };
}

/**
 * Create an error response.
 */
export function errorResponse(id: string, error: string): any {
  return {
    id,
    success: false,
    error,
  };
}

// ============================================================================
// Command Execution Router
// ============================================================================

/**
 * Execute a command against the daemon state.
 * This is the main dispatcher that routes commands to their handlers.
 */
export async function executeCommand(cmd: any, state: DaemonState): Promise<any> {
  const action = cmd.action || '';
  const id = cmd.id || '';
  const isWaitAction = WAIT_ACTIONS.has(action);
  let launchWarning: string | undefined;

  // Broadcast command to stream server
  if (state.streamServer) {
    state.streamServer.broadcastCommand(action, id, cmd);
  }

  // Drain and apply pending CDP events
  await state.drainCdpEventsBackground();

  // Hot-reload and check action policy
  if (state.policy) {
    state.policy.reload();
    const policyResult = state.policy.check(action);

    if (policyResult === 'deny') {
      return errorResponse(id, `Action '${action}' denied by policy`);
    }

    if (policyResult === 'requires_confirmation') {
      state.pendingConfirmation = {
        action,
        cmd,
      };
      return {
        id,
        success: true,
        data: {
          confirmation_required: true,
          action,
        },
      };
    }
  }

  // Check CLAW_BROWSER_CONFIRM_ACTIONS
  if (action !== 'confirm' && action !== 'deny') {
    if (state.confirmActions && state.confirmActions.requiresConfirmation(action)) {
      state.pendingConfirmation = {
        action,
        cmd,
      };
      return {
        id,
        success: true,
        data: {
          confirmation_required: true,
          confirmation_id: id,
          action,
        },
      };
    }
  }

  // Actions that skip auto-launch
  const skipLaunch = [
    '',
    'launch',
    'close',
    'har_stop',
    'credentials_set',
    'credentials_get',
    'credentials_delete',
    'credentials_list',
    'auth_save',
    'auth_show',
    'auth_delete',
    'auth_list',
    'state_list',
    'state_show',
    'state_clear',
    'state_clean',
    'state_rename',
    'device_list',
    'stream_enable',
    'stream_disable',
    'stream_status',
    'session_status',
    'flow_list',
    'flow_show',
    'flow_delete',
  ].includes(action);

  if (!skipLaunch) {
    // Check if browser needs launch
    const needsLaunch = !state.browser || !(await state.browser.isConnectionAlive?.());

    if (needsLaunch) {
      if (state.browser) {
        await state.browser.close?.();
        state.browser = null;
        state.screencasting = false;
        state.resetInputState();
        await state.updateStreamClient();
      }

      // Auto-launch
      const { autoLaunch } = await import('./lifecycle.js');
      try {
        const launchResult = await autoLaunch(state);
        launchWarning = launchResult.warning;
      } catch (err: any) {
        return errorResponse(id, `Auto-launch failed: ${err.message || String(err)}`);
      }
    }

    // Ensure at least one page exists
    if (state.browser && state.browser.pageCount?.() === 0) {
      await state.browser.ensurePage?.();
    }
  }

  if (cmd.tabId && state.browser && action !== 'tab_switch' && action !== 'tab_list' && action !== 'tab_new') {
    try {
      const resolvedTabId = resolveTabIdReference(state.browser, String(cmd.tabId));
      cmd.tabId = resolvedTabId;
      if (isWaitAction) {
        const pages = state.browser.getPages?.() || [];
        const page = pages.find((p: any) => p?.targetId === resolvedTabId);
        if (!page?.sessionId) {
          return errorResponse(id, `Tab not found: ${String(cmd.tabId)}`);
        }
        cmd.sessionId = page.sessionId;
      } else {
        state.browser.setActivePageByTargetId?.(resolvedTabId);
      }
    } catch (error: any) {
      return errorResponse(id, error?.message || `Tab not found: ${String(cmd.tabId)}`);
    }
  }

  // WebDriver backend: reject unsupported actions
  if (state.backendType === 'webdriver') {
    const unsupportedActions = [
      'trace_start',
      'trace_stop',
      'profiler_start',
      'profiler_stop',
      'recording_start',
      'recording_stop',
      'screencast_start',
      'screencast_stop',
    ];
    if (unsupportedActions.includes(action)) {
      return errorResponse(id, `Action '${action}' is not supported on the WebDriver backend`);
    }
  }

  // Route to handler
  try {
    const result = await routeAction(action, cmd, state);
    if (
      launchWarning &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      !('warning' in result)
    ) {
      (result as any).warning = launchWarning;
    }
    return result;
  } catch (error: any) {
    return errorResponse(id, error.message || String(error));
  }
}

/**
 * Route action to appropriate handler.
 */
async function routeAction(action: string, cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  // Dynamically import handlers
  const navigation = await import('./navigation.js');
  const interactions = await import('./interactions.js');
  const lifecycle = await import('./lifecycle.js');
  const snapshot = await import('./snapshot.js');
  const persistence = await import('./persistence.js');
  const tabs = await import('./tabs.js');
  const evaluate = await import('./evaluate.js');
  const queries = await import('./queries.js');
  const sessionData = await import('./session-data.js');
  const advanced = await import('./advanced.js');
  const flow = await import('./flow.js');

  switch (action) {
    // Browser lifecycle
    case 'launch':
      return lifecycle.handleLaunch(cmd, state);
    case 'close':
      return lifecycle.handleClose(cmd, state);

    // Navigation
    case 'navigate':
      return navigation.handleNavigate(cmd, state);
    case 'url':
      return navigation.handleUrl(cmd, state);
    case 'cdp_url':
      return navigation.handleCdpUrl(cmd, state);
    case 'title':
      return navigation.handleTitle(cmd, state);
    case 'content':
      return navigation.handleContent(cmd, state);
    case 'back':
      return navigation.handleBack(cmd, state);
    case 'forward':
      return navigation.handleForward(cmd, state);
    case 'reload':
      return navigation.handleReload(cmd, state);

    // Snapshot and screenshot
    case 'snapshot':
      return snapshot.handleSnapshot(cmd, state);
    case 'screenshot':
      return snapshot.handleScreenshot(cmd, state);
    case 'pdf':
      return advanced.handlePdf(cmd, state);

    // Element interactions
    case 'click':
      return interactions.handleClick(cmd, state);
    case 'dblclick':
      return interactions.handleDblclick(cmd, state);
    case 'fill':
      return interactions.handleFill(cmd, state);
    case 'type':
      return interactions.handleType(cmd, state);
    case 'press':
      return interactions.handlePress(cmd, state);
    case 'hover':
      return interactions.handleHover(cmd, state);
    case 'scroll':
      return interactions.handleScroll(cmd, state);
    case 'select':
      return interactions.handleSelect(cmd, state);
    case 'check':
      return interactions.handleCheck(cmd, state);
    case 'uncheck':
      return interactions.handleUncheck(cmd, state);
    case 'focus':
      return interactions.handleFocus(cmd, state);
    case 'clear':
      return interactions.handleFill({ ...cmd, value: '' }, state);
    case 'tap':
      return advanced.handleTap(cmd, state);
    case 'drag':
      return interactions.handleDrag(cmd, state);

    // Element queries
    case 'gettext':
      return queries.handleGettext(cmd, state);
    case 'getattribute':
      return queries.handleGetattribute(cmd, state);
    case 'isvisible':
      return queries.handleIsvisible(cmd, state);
    case 'isenabled':
      return queries.handleIsenabled(cmd, state);
    case 'ischecked':
      return queries.handleIschecked(cmd, state);
    case 'innertext':
      return queries.handleInnertext(cmd, state);
    case 'innerhtml':
      return queries.handleInnerhtml(cmd, state);
    case 'inputvalue':
      return queries.handleInputvalue(cmd, state);
    case 'boundingbox':
      return queries.handleBoundingbox(cmd, state);
    case 'count':
      return queries.handleCount(cmd, state);

    // Locators
    case 'getbyrole':
    case 'getbytext':
    case 'getbylabel':
    case 'getbyplaceholder':
    case 'getbyalttext':
    case 'getbytitle':
    case 'getbytestid':
      return advanced.handleGetBy(cmd, state);
    case 'nth':
      return advanced.handleNth(cmd, state);
    case 'find':
      return advanced.handleFind(cmd, state);

    // Wait operations
    case 'wait': {
      const wait = await import('./wait.js');
      return await wait.handleWait(cmd, state);
    }
    case 'waitforurl': {
      const wait = await import('./wait.js');
      return await wait.handleWaitForUrl(cmd, state);
    }
    case 'waitforloadstate': {
      const wait = await import('./wait.js');
      return await wait.handleWaitForLoadState(cmd, state);
    }
    case 'waitforfunction': {
      const wait = await import('./wait.js');
      return await wait.handleWaitForFunction(cmd, state);
    }
    case 'waitfordownload': {
      const wait = await import('./wait.js');
      return await wait.handleWaitForDownload(cmd, state);
    }

    // Mouse and keyboard
    case 'mouse':
      return interactions.handleMouse(cmd, state);
    case 'keyboard':
      return interactions.handleKeyboard(cmd, state);
    case 'keydown':
      return interactions.handleKeydown(cmd, state);
    case 'keyup':
      return interactions.handleKeyup(cmd, state);
    case 'wheel':
      return interactions.handleMouse({ ...cmd, event: 'wheel' }, state);

    // Tabs
    case 'tab_list':
    case 'listTabs':
      return tabs.handleTabList(cmd, state);
    case 'tab_new':
    case 'newTab':
      return tabs.handleTabNew(cmd, state);
    case 'tab_switch':
    case 'switchTab':
      return tabs.handleTabSwitch(cmd, state);
    case 'tab_close':
    case 'closeTab':
      return tabs.handleTabClose(cmd, state);
    case 'window_new':
      return tabs.handleWindowNew(cmd, state);

    // Frames
    case 'frame':
      return advanced.handleFrame(cmd, state);
    case 'mainframe':
      return advanced.handleMainFrame(cmd, state);

    // Cookies and storage
    case 'cookies_get':
      return sessionData.handleCookiesGet(cmd, state);
    case 'cookies_set':
      return sessionData.handleCookiesSet(cmd, state);
    case 'cookies_clear':
      return sessionData.handleCookiesClear(cmd, state);
    case 'storage_get':
      return sessionData.handleStorageGet(cmd, state);
    case 'storage_set':
      return sessionData.handleStorageSet(cmd, state);
    case 'storage_clear':
      return sessionData.handleStorageClear(cmd, state);

    // Network
    case 'setcontent':
      return advanced.handleSetContent(cmd, state);
    case 'headers':
      return sessionData.handleSetHeaders(cmd, state);
    case 'offline':
      return sessionData.handleSetOffline(cmd, state);

    // Console and errors
    case 'console':
      return advanced.handleConsole(cmd, state);
    case 'errors':
      return advanced.handleErrors(cmd, state);

    // JavaScript evaluation
    case 'evaluate':
      return evaluate.handleEvaluate(cmd, state);
    case 'evalhandle':
      return evaluate.handleEvalHandle(cmd, state);

    // HAR recording
    case 'har_start':
      return advanced.handleHarStart(cmd, state);
    case 'har_stop':
      return advanced.handleHarStop(cmd, state);

    // Route interception
    case 'route':
      return advanced.handleRoute(cmd, state);
    case 'unroute':
      return advanced.handleUnroute(cmd, state);
    case 'network_requests':
      return advanced.handleNetworkRequests(cmd, state);
    case 'network_request':
      return advanced.handleNetworkRequest(cmd, state);

    // Download management
    case 'download':
      return advanced.handleDownload(cmd, state);

    // Media and viewport
    case 'viewport':
      return sessionData.handleSetViewport(cmd, state);
    case 'useragent':
    case 'user_agent':
      return advanced.handleUserAgent(cmd, state);
    case 'set_media':
      return advanced.handleSetMedia(cmd, state);
    case 'device':
      return advanced.handleDevice(cmd, state);
    case 'timezone':
      return advanced.handleTimezone(cmd, state);
    case 'locale':
      return advanced.handleLocale(cmd, state);
    case 'geolocation':
      return advanced.handleGeolocation(cmd, state);
    case 'permissions':
      return advanced.handlePermissions(cmd, state);

    // Dialogs
    case 'dialog':
      return advanced.handleDialog(cmd, state);

    // State persistence
    case 'state_save': {
      if (!state.browser) {
        return errorResponse(id, 'Browser not launched');
      }
      const sessionId = state.browser.activeSessionId?.() || '';
      try {
        const path = await persistence.saveState(state.browser.client, sessionId, {
          path: cmd.path,
          sessionName: state.sessionName || undefined,
          sessionIdStr: cmd.sessionId,
          visitedOrigins: state.visitedOrigins,
        });
        return successResponse(id, { path });
      } catch (error: any) {
        return errorResponse(id, error.message || String(error));
      }
    }
    case 'state_load': {
      if (!state.browser) {
        return errorResponse(id, 'Browser not launched');
      }
      if (!cmd.path) {
        return errorResponse(id, 'Missing path parameter');
      }
      const sessionId = state.browser.activeSessionId?.() || '';
      try {
        await persistence.loadState(state.browser.client, sessionId, cmd.path);
        return successResponse(id, { loaded: true });
      } catch (error: any) {
        return errorResponse(id, error.message || String(error));
      }
    }
    case 'state_list':
    case 'state_show':
    case 'state_clear':
    case 'state_clean':
    case 'state_rename': {
      try {
        const result = persistence.dispatchStateCommand(cmd);
        if (result === null) {
          return errorResponse(id, `Unknown state action: ${action}`);
        }
        const data = await result;
        return successResponse(id, data);
      } catch (error: any) {
        return errorResponse(id, error.message || String(error));
      }
    }

    // Flow recording and replay
    case 'flow_record':
      return flow.handleFlowRecord(cmd, state);
    case 'flow_stop':
      return flow.handleFlowStop(cmd, state);
    case 'flow_list':
      return flow.handleFlowList(cmd, state);
    case 'flow_show':
      return flow.handleFlowShow(cmd, state);
    case 'flow_run':
      return flow.handleFlowRun(cmd, state);
    case 'flow_delete':
      return flow.handleFlowDelete(cmd, state);

    // Tracing
    case 'trace_start':
      return advanced.handleTraceStart(cmd, state);
    case 'trace_stop':
      return advanced.handleTraceStop(cmd, state);
    case 'profiler_start':
      return advanced.handleProfilerStart(cmd, state);
    case 'profiler_stop':
      return advanced.handleProfilerStop(cmd, state);

    // Recording
    case 'recording_start':
      return advanced.handleRecordingStart(cmd, state);
    case 'recording_stop':
      return advanced.handleRecordingStop(cmd, state);
    case 'recording_restart':
      await advanced.handleRecordingStop(cmd, state);
      return advanced.handleRecordingStart(cmd, state);
    case 'video_start':
      return advanced.handleVideoStart(cmd, state);
    case 'video_stop':
      return advanced.handleVideoStop(cmd, state);

    // Streaming
    case 'stream_enable':
      return advanced.handleStreamEnable(cmd, state);
    case 'stream_disable':
      return advanced.handleStreamDisable(cmd, state);
    case 'stream_status':
      return advanced.handleStreamStatus(cmd, state);
    case 'screencast_start':
      return advanced.handleScreencastStart(cmd, state);
    case 'screencast_stop':
      return advanced.handleScreencastStop(cmd, state);

    // Diff operations
    case 'diff_snapshot':
      return errorResponse(id, 'diff_snapshot handler not yet implemented');
    case 'diff_url':
      return errorResponse(id, 'diff_url handler not yet implemented');
    case 'diff_screenshot':
      return errorResponse(id, 'diff_screenshot handler not yet implemented');

    // Authentication
    case 'credentials_set':
      return errorResponse(id, 'credentials_set handler not yet implemented');
    case 'credentials_get':
      return errorResponse(id, 'credentials_get handler not yet implemented');
    case 'credentials_delete':
      return errorResponse(id, 'credentials_delete handler not yet implemented');
    case 'credentials_list':
      return errorResponse(id, 'credentials_list handler not yet implemented');
    case 'auth_save':
      return errorResponse(id, 'auth_save handler not yet implemented');
    case 'auth_show':
      return errorResponse(id, 'auth_show handler not yet implemented');
    case 'auth_delete':
      return errorResponse(id, 'auth_delete handler not yet implemented');
    case 'auth_list':
      return errorResponse(id, 'auth_list handler not yet implemented');

    // Advanced actions
    case 'inspect':
      return advanced.handleInspect(cmd, state);
    case 'session_status':
      return advanced.handleSessionStatus(cmd, state);
    case 'selectall':
      return advanced.handleSelectAll(cmd, state);
    case 'scrollintoview':
      return interactions.handleScrollIntoView(cmd, state);
    case 'dispatch':
      return advanced.handleDispatch(cmd, state);
    case 'highlight':
      return advanced.handleHighlight(cmd, state);
    case 'setvalue':
      return interactions.handleFill({ ...cmd, value: cmd.value ?? cmd.text }, state);
    case 'styles':
      return queries.handleStyles(cmd, state);
    case 'bringtofront':
      return advanced.handleBringToFront(cmd, state);
    case 'upload':
      return interactions.handleUpload(cmd, state);
    case 'addscript':
      return advanced.handleAddScript(cmd, state);
    case 'addinitscript':
      return advanced.handleAddInitScript(cmd, state);
    case 'addstyle':
      return advanced.handleAddStyle(cmd, state);
    case 'clipboard':
      return advanced.handleClipboard(cmd, state);
    case 'device_list':
      return advanced.handleDeviceList(cmd, state);
    case 'expose':
      return errorResponse(id, 'expose handler not yet implemented');
    case 'pause':
      return advanced.handlePause(cmd, state);
    case 'multiselect':
      return errorResponse(id, 'multiselect handler not yet implemented');
    case 'responsebody':
      return advanced.handleResponseBody(cmd, state);
    case 'install':
      return errorResponse(id, 'install command is managed by the Rust claw-browser binary and is not implemented in claw-browser yet');
    case 'upgrade':
      return errorResponse(id, 'upgrade command is managed by the Rust claw-browser binary and is not implemented in claw-browser yet');
    case 'chat':
      return errorResponse(id, 'chat command is not implemented in claw-browser yet');
    // Confirmation
    case 'confirm':
      return advanced.handleConfirm(cmd, state);
    case 'deny':
      return advanced.handleDeny(cmd, state);

    default:
      return errorResponse(id, `Unknown action: ${action}`);
  }
}

const WAIT_ACTIONS = new Set([
  'wait',
  'waitforurl',
  'waitforloadstate',
  'waitforfunction',
  'waitfordownload',
]);
