import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { CdpClient } from '../cdp/client.js';
import type { Cookie } from '../cdp/cookies.js';
import { getAllCookies, setCookies } from '../cdp/cookies.js';
import { encrypt, decrypt, deriveKey } from './encryption.js';

/**
 * State persistence with storage collection and restore
 * Translated from cli/src/native/state.rs
 */

export interface StorageEntry {
  name: string;
  value: string;
}

export interface OriginStorage {
  origin: string;
  localStorage: StorageEntry[];
  sessionStorage: StorageEntry[];
}

export interface StorageState {
  cookies: Cookie[];
  origins: OriginStorage[];
}

/**
 * Collect frame origins from frame tree
 */
function collectFrameOrigins(tree: any, origins: Set<string>): void {
  if (tree.frame?.url) {
    try {
      const url = new URL(tree.frame.url);
      const origin = url.origin;
      if (origin !== 'null' && origin !== '') {
        origins.add(origin);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  if (Array.isArray(tree.childFrames)) {
    for (const child of tree.childFrames) {
      collectFrameOrigins(child, origins);
    }
  }
}

/**
 * Parse origin storage data from JS evaluation result
 */
function parseOriginStorage(data: any): OriginStorage | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const origin = data.origin || '';
  if (!origin || origin === 'null') {
    return null;
  }

  const localStorage: StorageEntry[] = Array.isArray(data.localStorage)
    ? data.localStorage
    : [];
  const sessionStorage: StorageEntry[] = Array.isArray(data.sessionStorage)
    ? data.sessionStorage
    : [];

  return {
    origin,
    localStorage,
    sessionStorage,
  };
}

/**
 * Evaluate storage collection JS and parse result
 */
async function evalOriginStorage(
  client: CdpClient,
  sessionId: string,
  originJs: string
): Promise<OriginStorage | null> {
  try {
    const result = await client.sendCommand<any>(
      'Runtime.evaluate',
      {
        expression: originJs,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId
    );

    const data = result?.result?.value;
    return parseOriginStorage(data);
  } catch {
    return null;
  }
}

/**
 * Collect storage from a specific target
 */
async function collectStorageInTarget(
  client: CdpClient,
  targetId: string,
  origins: string[],
  originJs: string
): Promise<OriginStorage[]> {
  // Attach to target
  const attachResult = await client.sendCommand<any>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  const tempSession = attachResult.sessionId;

  // Enable required domains
  await client.sendCommand('Page.enable', {}, tempSession);
  await client.sendCommand('Runtime.enable', {}, tempSession);

  // Blank HTML for intercepted requests
  const blankHtmlB64 = Buffer.from('<html></html>').toString('base64');

  // Enable fetch interception
  await client
    .sendCommand(
      'Fetch.enable',
      {
        patterns: [{ urlPattern: '*' }],
      },
      tempSession
    )
    .catch(() => {
      // Ignore fetch enable errors
    });

  const results: OriginStorage[] = [];

  // Listen for CDP events
  const eventListener = (params: any, eventSessionId?: string) => {
    if (eventSessionId === tempSession && params.requestId) {
      // Fulfill intercepted requests with blank HTML
      client
        .sendCommand(
          'Fetch.fulfillRequest',
          {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            body: blankHtmlB64,
          },
          tempSession
        )
        .catch(() => {
          // Ignore fulfillment errors
        });
    }
  };

  client.on('Fetch.requestPaused', eventListener);

  try {
    for (const targetOrigin of origins) {
      const navUrl = targetOrigin.endsWith('/')
        ? targetOrigin
        : `${targetOrigin}/`;

      try {
        await client.sendCommand('Page.navigate', { url: navUrl }, tempSession);
      } catch {
        continue;
      }

      // Wait for page load with timeout
      const loadPromise = new Promise<void>((resolve) => {
        const loadHandler = (params: any, eventSessionId?: string) => {
          if (eventSessionId === tempSession) {
            client.off('Page.loadEventFired', loadHandler);
            resolve();
          }
        };
        client.on('Page.loadEventFired', loadHandler);

        // Timeout after 5 seconds
        setTimeout(() => {
          client.off('Page.loadEventFired', loadHandler);
          resolve();
        }, 5000);
      });

      await loadPromise;

      // Collect storage from this origin
      const storage = await evalOriginStorage(client, tempSession, originJs);
      if (
        storage &&
        (storage.localStorage.length > 0 || storage.sessionStorage.length > 0)
      ) {
        results.push(storage);
      }
    }
  } finally {
    client.off('Fetch.requestPaused', eventListener);
  }

  return results;
}

/**
 * Collect storage from origins via temporary target
 */
async function collectStorageViaTempTarget(
  client: CdpClient,
  origins: string[],
  originJs: string
): Promise<OriginStorage[]> {
  // Create temporary target
  const createResult = await client.sendCommand<any>('Target.createTarget', {
    url: 'about:blank',
  });

  const targetId = createResult.targetId;

  try {
    return await collectStorageInTarget(client, targetId, origins, originJs);
  } finally {
    // Close temporary target
    await client
      .sendCommand('Target.closeTarget', { targetId })
      .catch(() => {
        // Ignore close errors
      });
  }
}

/**
 * Get sessions directory path
 */
export function getSessionsDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.claw-browser', 'sessions');
}

/**
 * Save browser state (cookies + storage)
 */
export async function saveState(
  client: CdpClient,
  sessionId: string,
  options: {
    path?: string;
    sessionName?: string;
    sessionIdStr?: string;
    visitedOrigins?: Set<string>;
  } = {}
): Promise<string> {
  // Collect cookies
  const cookies = await getAllCookies(client, sessionId);

  // JavaScript to collect localStorage and sessionStorage
  const originJs = `(() => {
    const result = { origin: location.origin, localStorage: [], sessionStorage: [] };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        result.localStorage.push({ name: key, value: localStorage.getItem(key) });
      }
    } catch(e) {}
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        result.sessionStorage.push({ name: key, value: sessionStorage.getItem(key) });
      }
    } catch(e) {}
    return result;
  })()`;

  // Merge visited origins with current frame tree origins
  const allOrigins = new Set(options.visitedOrigins || []);

  try {
    const treeResult = await client.sendCommand<any>(
      'Page.getFrameTree',
      {},
      sessionId
    );
    if (treeResult.frameTree) {
      collectFrameOrigins(treeResult.frameTree, allOrigins);
    }
  } catch {
    // Ignore frame tree errors
  }

  // Collect localStorage from current page
  const origins: OriginStorage[] = [];
  let currentOrigin = '';

  const currentStorage = await evalOriginStorage(client, sessionId, originJs);
  if (currentStorage) {
    currentOrigin = currentStorage.origin;
    if (
      currentStorage.localStorage.length > 0 ||
      currentStorage.sessionStorage.length > 0
    ) {
      origins.push(currentStorage);
    }
  }

  // Collect localStorage from remaining origins via temp target
  allOrigins.delete(currentOrigin);
  if (allOrigins.size > 0) {
    const remaining = Array.from(allOrigins);
    try {
      const tempOrigins = await collectStorageViaTempTarget(
        client,
        remaining,
        originJs
      );
      origins.push(...tempOrigins);
    } catch {
      // Ignore temp target errors
    }
  }

  // Build state object
  const state: StorageState = {
    cookies,
    origins,
  };

  const jsonStr = JSON.stringify(state, null, 2);

  // Determine save path
  let savePath = options.path;
  if (!savePath) {
    const dir = getSessionsDir();
    await fs.mkdir(dir, { recursive: true });
    const name = options.sessionName || 'default';
    const idStr = options.sessionIdStr || Date.now().toString();
    savePath = path.join(dir, `${name}-${idStr}.json`);
  }

  // Check for encryption
  const encryptionKey = process.env.CLAW_BROWSER_ENCRYPTION_KEY;
  if (encryptionKey) {
    const key = deriveKey(encryptionKey);
    const encrypted = encrypt(Buffer.from(jsonStr, 'utf-8'), key);
    savePath += '.enc';
    await fs.writeFile(savePath, encrypted);
  } else {
    await fs.writeFile(savePath, jsonStr, 'utf-8');
  }

  return savePath;
}

/**
 * Load browser state (cookies + storage)
 */
export async function loadState(
  client: CdpClient,
  sessionId: string,
  filePath: string
): Promise<void> {
  let jsonStr: string;

  if (filePath.endsWith('.enc')) {
    // Encrypted file
    const encryptionKey = process.env.CLAW_BROWSER_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error(
        'Encrypted state file requires CLAW_BROWSER_ENCRYPTION_KEY'
      );
    }

    const key = deriveKey(encryptionKey);
    const data = await fs.readFile(filePath);
    const decrypted = decrypt(data, key);
    jsonStr = decrypted.toString('utf-8');
  } else {
    // Plain file - try to read directly first
    try {
      jsonStr = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      // Try .enc version if encryption key is available
      const encryptionKey = process.env.CLAW_BROWSER_ENCRYPTION_KEY;
      if (encryptionKey) {
        const encPath = `${filePath}.enc`;
        try {
          const key = deriveKey(encryptionKey);
          const data = await fs.readFile(encPath);
          const decrypted = decrypt(data, key);
          jsonStr = decrypted.toString('utf-8');
        } catch {
          throw error; // Rethrow original error
        }
      } else {
        throw error;
      }
    }
  }

  const state: StorageState = JSON.parse(jsonStr);

  // Load cookies
  if (state.cookies.length > 0) {
    await setCookies(client, sessionId, state.cookies);
  }

  // Load storage per origin
  for (const origin of state.origins) {
    if (
      origin.localStorage.length === 0 &&
      origin.sessionStorage.length === 0
    ) {
      continue;
    }

    // Navigate to origin to set storage
    const navigateUrl = origin.origin.endsWith('/')
      ? origin.origin
      : `${origin.origin}/`;

    try {
      await client.sendCommand('Page.navigate', { url: navigateUrl }, sessionId);
    } catch {
      continue;
    }

    // Brief wait for navigation
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Set localStorage
    for (const entry of origin.localStorage) {
      const js = `localStorage.setItem(${JSON.stringify(entry.name)}, ${JSON.stringify(entry.value)})`;
      await client
        .sendCommand<any>(
          'Runtime.evaluate',
          {
            expression: js,
            returnByValue: true,
            awaitPromise: false,
          },
          sessionId
        )
        .catch(() => {
          // Ignore errors
        });
    }

    // Set sessionStorage
    for (const entry of origin.sessionStorage) {
      const js = `sessionStorage.setItem(${JSON.stringify(entry.name)}, ${JSON.stringify(entry.value)})`;
      await client
        .sendCommand<any>(
          'Runtime.evaluate',
          {
            expression: js,
            returnByValue: true,
            awaitPromise: false,
          },
          sessionId
        )
        .catch(() => {
          // Ignore errors
        });
    }
  }
}

/**
 * Check if file is a state file
 */
function isStateFile(filePath: string): boolean {
  return filePath.endsWith('.json') || filePath.endsWith('.json.enc');
}

/**
 * Check if state file is encrypted
 */
function isEncryptedState(filePath: string): boolean {
  return filePath.endsWith('.json.enc');
}

/**
 * List all saved state files
 */
export async function stateList(): Promise<any> {
  const dir = getSessionsDir();

  try {
    await fs.access(dir);
  } catch {
    return {
      files: [],
      directory: dir,
    };
  }

  const files: any[] = [];
  const entries = await fs.readdir(dir);

  for (const filename of entries) {
    const filePath = path.join(dir, filename);
    if (!isStateFile(filename)) {
      continue;
    }

    try {
      const stats = await fs.stat(filePath);
      files.push({
        filename,
        path: filePath,
        size: stats.size,
        modified: Math.floor(stats.mtimeMs / 1000),
        encrypted: isEncryptedState(filename),
      });
    } catch {
      // Skip files with stat errors
    }
  }

  return {
    files,
    directory: dir,
  };
}

/**
 * Show state file contents
 */
export async function stateShow(filePath: string): Promise<any> {
  const encrypted = filePath.endsWith('.enc');

  let jsonStr: string;
  if (encrypted) {
    const encryptionKey = process.env.CLAW_BROWSER_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error(
        'Encrypted state file requires CLAW_BROWSER_ENCRYPTION_KEY'
      );
    }

    const key = deriveKey(encryptionKey);
    const data = await fs.readFile(filePath);
    const decrypted = decrypt(data, key);
    jsonStr = decrypted.toString('utf-8');
  } else {
    jsonStr = await fs.readFile(filePath, 'utf-8');
  }

  const state: StorageState = JSON.parse(jsonStr);
  const stats = await fs.stat(filePath);
  const filename = path.basename(filePath);

  return {
    filename,
    path: filePath,
    size: stats.size,
    modified: Math.floor(stats.mtimeMs / 1000),
    encrypted,
    summary: `${state.cookies.length} cookies, ${state.origins.length} origins`,
    state,
  };
}

/**
 * Clear state files
 */
export async function stateClear(filePath?: string): Promise<any> {
  if (filePath) {
    await fs.unlink(filePath);
    return { deleted: filePath };
  }

  const dir = getSessionsDir();
  try {
    await fs.access(dir);
  } catch {
    return { deleted: 0 };
  }

  let count = 0;
  const entries = await fs.readdir(dir);

  for (const filename of entries) {
    const fullPath = path.join(dir, filename);
    if (isStateFile(filename)) {
      try {
        await fs.unlink(fullPath);
        count++;
      } catch {
        // Ignore deletion errors
      }
    }
  }

  return { deleted: count };
}

/**
 * Clean old state files
 */
export async function stateClean(maxAgeDays: number): Promise<any> {
  const dir = getSessionsDir();
  try {
    await fs.access(dir);
  } catch {
    return { cleaned: 0, keptCount: 0, days: maxAgeDays };
  }

  const now = Date.now();
  const maxAge = maxAgeDays * 86400 * 1000; // Convert to milliseconds
  let deleted = 0;
  let kept = 0;

  const entries = await fs.readdir(dir);

  for (const filename of entries) {
    const fullPath = path.join(dir, filename);
    if (!isStateFile(filename)) {
      continue;
    }

    try {
      const stats = await fs.stat(fullPath);
      const age = now - stats.mtimeMs;

      if (age > maxAge) {
        await fs.unlink(fullPath);
        deleted++;
      } else {
        kept++;
      }
    } catch {
      // Skip files with errors
    }
  }

  return { cleaned: deleted, keptCount: kept, days: maxAgeDays };
}

/**
 * Rename state file
 */
export async function stateRename(
  oldPath: string,
  newName: string
): Promise<any> {
  try {
    await fs.access(oldPath);
  } catch {
    throw new Error(`State file not found: ${oldPath}`);
  }

  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, `${newName}.json`);

  await fs.rename(oldPath, newPath);

  return {
    renamed: true,
    from: oldPath,
    to: newPath,
  };
}

/**
 * Find most recent auto-saved state file for session
 */
export async function findAutoStateFile(
  sessionName: string
): Promise<string | null> {
  const dir = getSessionsDir();

  try {
    await fs.access(dir);
  } catch {
    return null;
  }

  const prefix = `${sessionName}-`;
  let bestPath: string | null = null;
  let bestTime = 0;

  const entries = await fs.readdir(dir);

  for (const filename of entries) {
    const isMatch =
      filename.startsWith(prefix) &&
      (filename.endsWith('.json') || filename.endsWith('.json.enc'));

    if (!isMatch) {
      continue;
    }

    const fullPath = path.join(dir, filename);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.mtimeMs > bestTime) {
        bestPath = fullPath;
        bestTime = stats.mtimeMs;
      }
    } catch {
      // Skip files with stat errors
    }
  }

  return bestPath;
}

/**
 * Dispatch state command from JSON payload
 */
export function dispatchStateCommand(cmd: any): any | null {
  const action = cmd.action;

  switch (action) {
    case 'state_list':
      return stateList();

    case 'state_show':
      if (!cmd.path) {
        throw new Error("Missing 'path' parameter");
      }
      return stateShow(cmd.path);

    case 'state_clear':
      return stateClear(cmd.path);

    case 'state_clean': {
      const days = cmd.days || 30;
      return stateClean(days);
    }

    case 'state_rename':
      if (!cmd.path) {
        throw new Error("Missing 'path' parameter");
      }
      if (!cmd.name) {
        throw new Error("Missing 'name' parameter");
      }
      return stateRename(cmd.path, cmd.name);

    default:
      return null;
  }
}
