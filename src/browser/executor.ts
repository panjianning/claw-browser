import type { DaemonState } from './state.js';

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

  const cmdStart = Date.now();

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

  // Check AGENT_BROWSER_CONFIRM_ACTIONS
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
        await autoLaunch(state);
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
      state.browser.setActivePageByTargetId?.(cmd.tabId);
    } catch (error: any) {
      return errorResponse(id, error?.message || `Tab not found: ${cmd.tabId}`);
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
      return errorResponse(id, 'pdf handler not yet implemented');

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
      return errorResponse(id, 'clear handler not yet implemented');
    case 'tap':
      return errorResponse(id, 'tap handler not yet implemented');
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
      return errorResponse(id, 'getbyrole handler not yet implemented');
    case 'getbytext':
      return errorResponse(id, 'getbytext handler not yet implemented');
    case 'getbylabel':
      return errorResponse(id, 'getbylabel handler not yet implemented');
    case 'getbyplaceholder':
      return errorResponse(id, 'getbyplaceholder handler not yet implemented');
    case 'getbyalttext':
      return errorResponse(id, 'getbyalttext handler not yet implemented');
    case 'getbytitle':
      return errorResponse(id, 'getbytitle handler not yet implemented');
    case 'getbytestid':
      return errorResponse(id, 'getbytestid handler not yet implemented');
    case 'nth':
      return errorResponse(id, 'nth handler not yet implemented');
    case 'find':
      return errorResponse(id, 'find handler not yet implemented');

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
      return errorResponse(id, 'wheel handler not yet implemented');

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
      return errorResponse(id, 'frame handler not yet implemented');
    case 'mainframe':
      return errorResponse(id, 'mainframe handler not yet implemented');

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
      return errorResponse(id, 'setcontent handler not yet implemented');
    case 'headers':
      return sessionData.handleSetHeaders(cmd, state);
    case 'offline':
      return sessionData.handleSetOffline(cmd, state);

    // Console and errors
    case 'console':
      return errorResponse(id, 'console handler not yet implemented');
    case 'errors':
      return errorResponse(id, 'errors handler not yet implemented');

    // JavaScript evaluation
    case 'evaluate':
      return evaluate.handleEvaluate(cmd, state);
    case 'evalhandle':
      return errorResponse(id, 'evalhandle handler not yet implemented');

    // HAR recording
    case 'har_start':
      return errorResponse(id, 'har_start handler not yet implemented');
    case 'har_stop':
      return errorResponse(id, 'har_stop handler not yet implemented');

    // Route interception
    case 'route':
      return errorResponse(id, 'route handler not yet implemented');
    case 'unroute':
      return errorResponse(id, 'unroute handler not yet implemented');
    case 'network_requests':
      return errorResponse(id, 'network requests listing is not yet implemented');
    case 'network_request':
      return errorResponse(id, 'network request detail is not yet implemented');

    // Download management
    case 'download':
      return errorResponse(id, 'download handler not yet implemented');

    // Media and viewport
    case 'viewport':
      return sessionData.handleSetViewport(cmd, state);
    case 'useragent':
    case 'user_agent':
      return errorResponse(id, 'useragent handler not yet implemented');
    case 'set_media':
      return errorResponse(id, 'set_media handler not yet implemented');
    case 'device':
      return errorResponse(id, 'device handler not yet implemented');
    case 'timezone':
      return errorResponse(id, 'timezone handler not yet implemented');
    case 'locale':
      return errorResponse(id, 'locale handler not yet implemented');
    case 'geolocation':
      return errorResponse(id, 'geolocation handler not yet implemented');
    case 'permissions':
      return errorResponse(id, 'permissions handler not yet implemented');

    // Dialogs
    case 'dialog':
      return errorResponse(id, 'dialog handler not yet implemented');

    // State persistence
    case 'state_save': {
      if (!state.browser) {
        return errorResponse(id, 'Browser not launched');
      }
      const sessionId = state.browser.activeSessionId?.() || '';
      try {
        const path = await persistence.saveState(state.browser.client, sessionId, {
          path: cmd.path,
          sessionName: state.sessionName,
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

    // Tracing
    case 'trace_start':
      return errorResponse(id, 'trace_start handler not yet implemented');
    case 'trace_stop':
      return errorResponse(id, 'trace_stop handler not yet implemented');
    case 'profiler_start':
      return errorResponse(id, 'profiler_start handler not yet implemented');
    case 'profiler_stop':
      return errorResponse(id, 'profiler_stop handler not yet implemented');

    // Recording
    case 'recording_start':
      return errorResponse(id, 'recording_start handler not yet implemented');
    case 'recording_stop':
      return errorResponse(id, 'recording_stop handler not yet implemented');
    case 'recording_restart':
      return errorResponse(id, 'recording_restart handler not yet implemented');
    case 'video_start':
      return errorResponse(id, 'video_start handler not yet implemented');
    case 'video_stop':
      return errorResponse(id, 'video_stop handler not yet implemented');

    // Streaming
    case 'stream_enable':
      return errorResponse(id, 'stream_enable handler not yet implemented');
    case 'stream_disable':
      return errorResponse(id, 'stream_disable handler not yet implemented');
    case 'stream_status':
      return errorResponse(id, 'stream_status handler not yet implemented');
    case 'screencast_start':
      return errorResponse(id, 'screencast_start handler not yet implemented');
    case 'screencast_stop':
      return errorResponse(id, 'screencast_stop handler not yet implemented');

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
      return errorResponse(id, 'inspect handler not yet implemented');
    case 'selectall':
      return errorResponse(id, 'selectall handler not yet implemented');
    case 'scrollintoview':
      return interactions.handleScrollIntoView(cmd, state);
    case 'dispatch':
      return errorResponse(id, 'dispatch handler not yet implemented');
    case 'highlight':
      return errorResponse(id, 'highlight handler not yet implemented');
    case 'setvalue':
      return errorResponse(id, 'setvalue handler not yet implemented');
    case 'styles':
      return queries.handleStyles(cmd, state);
    case 'bringtofront':
      return errorResponse(id, 'bringtofront handler not yet implemented');
    case 'upload':
      return interactions.handleUpload(cmd, state);
    case 'addscript':
      return errorResponse(id, 'addscript handler not yet implemented');
    case 'addinitscript':
      return errorResponse(id, 'addinitscript handler not yet implemented');
    case 'addstyle':
      return errorResponse(id, 'addstyle handler not yet implemented');
    case 'clipboard':
      return errorResponse(id, 'clipboard handler not yet implemented');
    case 'device_list':
      return errorResponse(id, 'device_list handler not yet implemented');
    case 'expose':
      return errorResponse(id, 'expose handler not yet implemented');
    case 'pause':
      return errorResponse(id, 'pause handler not yet implemented');
    case 'multiselect':
      return errorResponse(id, 'multiselect handler not yet implemented');
    case 'responsebody':
      return errorResponse(id, 'responsebody handler not yet implemented');
    case 'install':
      return errorResponse(id, 'install command is managed by the Rust agent-browser binary and is not implemented in claw-browser yet');
    case 'upgrade':
      return errorResponse(id, 'upgrade command is managed by the Rust agent-browser binary and is not implemented in claw-browser yet');
    case 'chat':
      return errorResponse(id, 'chat command is not implemented in claw-browser yet');
    // Confirmation
    case 'confirm':
      return errorResponse(id, 'confirm handler not yet implemented');
    case 'deny':
      return errorResponse(id, 'deny handler not yet implemented');

    default:
      return errorResponse(id, `Unknown action: ${action}`);
  }
}
