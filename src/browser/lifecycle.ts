import type { DaemonState } from './state.js';
import { BrowserManager } from '../cdp/browser.js';
import crypto from 'crypto';
import { bindRuntimeEventTrackers } from './advanced.js';

/**
 * Browser lifecycle action handlers (launch, close)
 */

interface LaunchOptions {
  headless?: boolean;
  executablePath?: string;
  proxy?: string;
  proxyBypass?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  profile?: string;
  allowFileAccess?: boolean;
  args?: string[];
  extensions?: string[];
  storageState?: string;
  userAgent?: string;
  ignoreHTTPSErrors?: boolean;
  colorScheme?: string;
  downloadPath?: string;
  viewportSize?: { width: number; height: number };
  useRealKeychain?: boolean;
}

/**
 * Generate a hash of launch options to detect if relaunch is needed
 */
function launchHash(options: LaunchOptions): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(options));
  return hash.digest('hex');
}

/**
 * Parse launch options from command
 */
function parseLaunchOptions(cmd: any): LaunchOptions {
  const extensions = cmd.extensions
    ? Array.isArray(cmd.extensions)
      ? cmd.extensions.filter((v: any) => typeof v === 'string')
      : []
    : undefined;

  // Check CLAW_BROWSER_HEADED env var for headed mode
  const headedFromEnv = process.env.CLAW_BROWSER_HEADED === '1';
  
  return {
    headless: cmd.headless !== undefined ? Boolean(cmd.headless) : !headedFromEnv,
    executablePath:
      cmd.executablePath || process.env.CLAW_BROWSER_EXECUTABLE_PATH || undefined,
    proxy: cmd.proxy
      ? typeof cmd.proxy === 'string'
        ? cmd.proxy
        : cmd.proxy.server
      : undefined,
    proxyBypass: cmd.proxy?.bypass || undefined,
    proxyUsername:
      cmd.proxy?.username ||
      process.env.CLAW_BROWSER_PROXY_USERNAME ||
      undefined,
    proxyPassword:
      cmd.proxy?.password ||
      process.env.CLAW_BROWSER_PROXY_PASSWORD ||
      undefined,
    profile: cmd.profile || process.env.CLAW_BROWSER_PROFILE || undefined,
    allowFileAccess: cmd.allowFileAccess || false,
    args: cmd.args
      ? Array.isArray(cmd.args)
        ? cmd.args.filter((v: any) => typeof v === 'string')
        : []
      : [],
    extensions,
    storageState: cmd.storageState || undefined,
    userAgent: cmd.userAgent || undefined,
    ignoreHTTPSErrors: cmd.ignoreHTTPSErrors || false,
    colorScheme: cmd.colorScheme || undefined,
    downloadPath: cmd.downloadPath || undefined,
    viewportSize: undefined,
    useRealKeychain: false,
  };
}

function parseCdpTarget(raw: string): { cdpPort?: number; cdpUrl?: string } {
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const port = parseInt(value, 10);
    if (!Number.isNaN(port) && port > 0 && port <= 65535) {
      return { cdpPort: port };
    }
  }
  return { cdpUrl: value };
}

export async function handleLaunch(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const envCdp = process.env.CLAW_BROWSER_CDP?.trim();
  const parsedEnvCdp = envCdp ? parseCdpTarget(envCdp) : {};
  const cdpUrl = cmd.cdpUrl || parsedEnvCdp.cdpUrl;
  const cdpPort = cmd.cdpPort || parsedEnvCdp.cdpPort;
  const autoConnect = cmd.autoConnect || false;

  const launchOptions = parseLaunchOptions(cmd);
  const newHash = launchHash(launchOptions);

  // Check if relaunch is needed
  const needsRelaunch = await (async () => {
    if (!state.browser) {
      return true;
    }

    const isExternal = cdpUrl || cdpPort || autoConnect;
    const wasExternal = state.isCdpConnection;
    const hashChanged = !isExternal && state.launchHash !== newHash;

    return (
      isExternal !== wasExternal ||
      hashChanged ||
      state.hasProcessExited() ||
      !(await state.isConnectionAlive())
    );
  })();

  if (needsRelaunch) {
    if (state.browser) {
      await state.browser.close();
      state.browser = null;
      state.launchHash = null;
      state.screencasting = false;
      state.resetInputState();
      // TODO: state.updateStreamClient();
    }
  } else {
    return { id, success: true, data: { launched: true, reused: true } };
  }

  state.refMap.clear();

  const hasCdp = Boolean(cdpUrl || cdpPort);

  // Validate launch options
  // TODO: Add validation for extensions, profile, storageState, etc.
  // validateLaunchOptions(launchOptions.extensions, hasCdp, ...);

  // CDP URL connection
  if (cdpUrl) {
    state.resetInputState();
    state.browser = await BrowserManager.connect(cdpUrl);
    state.isCdpConnection = true;
    state.subscribeToEvents();
    bindRuntimeEventTrackers(state);
    state.startFetchHandler();
    state.startDialogHandler();
    // TODO: state.updateStreamClient();
    return { id, success: true, data: { launched: true } };
  }

  // CDP port connection
  if (cdpPort) {
    state.resetInputState();
    state.browser = await BrowserManager.connect(`127.0.0.1:${cdpPort}`);
    state.isCdpConnection = true;
    state.subscribeToEvents();
    bindRuntimeEventTrackers(state);
    state.startFetchHandler();
    state.startDialogHandler();
    // TODO: state.updateStreamClient();
    return { id, success: true, data: { launched: true } };
  }

  // Auto-connect to existing Chrome instance
  if (autoConnect) {
    state.resetInputState();
    // TODO: Implement connect_auto_with_fresh_tab
    // state.browser = await connectAutoWithFreshTab();
    state.isCdpConnection = true;
    state.subscribeToEvents();
    bindRuntimeEventTrackers(state);
    state.startFetchHandler();
    state.startDialogHandler();
    // TODO: state.updateStreamClient();
    return {
      id,
      success: false,
      error: 'autoConnect not yet implemented',
    };
  }

  // Provider connections (ios, safari, browserless, agentcore, etc.)
  if (cmd.provider) {
    return {
      id,
      success: false,
      error: `Provider "${cmd.provider}" not yet implemented`,
    };
  }

  const engine = cmd.engine || process.env.CLAW_BROWSER_ENGINE || 'chrome';

  // Store proxy credentials for Fetch.authRequired handling
  const hasProxyAuth = Boolean(launchOptions.proxyUsername);
  if (hasProxyAuth) {
    state.proxyCredentials = {
      username: launchOptions.proxyUsername || '',
      password: launchOptions.proxyPassword || '',
    };
  }

  // Domain filter
  if (cmd.allowedDomains) {
    // TODO: Implement domain filter
    // state.domainFilter = DomainFilter.new(cmd.allowedDomains);
  }

  state.engine = engine;
  // TODO: Write engine file
  // writeEngineFile(state.sessionId, state.engine);
  // writeExtensionsFile(state.sessionId);

  state.resetInputState();

  // Launch the browser
  try {
    state.browser = await BrowserManager.launch(launchOptions);
    state.launchHash = newHash;
    state.isCdpConnection = false;
    state.subscribeToEvents();
    bindRuntimeEventTrackers(state);
    state.startFetchHandler();
    state.startDialogHandler();
    // TODO: state.updateStreamClient();

    // Enable Fetch interception for domain filtering and/or proxy auth
    if (hasProxyAuth && state.browser) {
      const sessionId = state.browser.activeSessionId();
      await state.browser.client.sendCommand(
        'Fetch.enable',
        {
          handleAuthRequests: true,
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        },
        sessionId
      );
    }

    return {
      id,
      success: true,
      data: { launched: true },
    };
  } catch (err: any) {
    return {
      id,
      success: false,
      error: err.message || 'Failed to launch browser',
    };
  }
}

export async function handleClose(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  // Save state if session name provided
  if (state.sessionName) {
    try {
      // TODO: Implement state save from cli/src/native/state.rs
      // await saveState(state);
    } catch (e: any) {
      console.error('Failed to save state:', e.message);
    }
  }

  // Stop background tasks
  state.stopFetchHandler();
  state.stopDialogHandler();

  // Stop recording if active
  if (state.recordingState) {
    // TODO: Stop recording task
  }

  // Close browser
  if (state.browser) {
    try {
      await state.browser.close();
      state.browser = null;
    } catch (e: any) {
      console.error('Failed to close browser:', e.message);
    }
  }

  // Close WebDriver backend
  if (state.webdriverBackend) {
    try {
      await state.webdriverBackend.close();
      state.webdriverBackend = null;
    } catch (e: any) {
      console.error('Failed to close WebDriver backend:', e.message);
    }
  }

  // Close Appium
  if (state.appium) {
    try {
      await state.appium.close();
      state.appium = null;
    } catch (e: any) {
      console.error('Failed to close Appium:', e.message);
    }
  }

  // Clear state
  state.refMap.clear();
  state.iframeSessions.clear();
  state.activeFrameId = null;

  return { id, success: true, data: { closed: true } };
}

/**
 * Auto-launch helper - called by executor when browser is needed but not running
 */
export async function autoLaunch(state: DaemonState): Promise<void> {
  // Use default launch command
  const launchCmd: any = {
    action: 'launch',
    id: 'auto-launch',
  };

  const envCdp = process.env.CLAW_BROWSER_CDP?.trim();
  if (envCdp) {
    const parsed = parseCdpTarget(envCdp);
    if (parsed.cdpPort) {
      launchCmd.cdpPort = parsed.cdpPort;
    } else if (parsed.cdpUrl) {
      launchCmd.cdpUrl = parsed.cdpUrl;
    }
  }

  const result = await handleLaunch(launchCmd, state);
  if (!result.success) {
    throw new Error(`Auto-launch failed: ${result.error}`);
  }
}
