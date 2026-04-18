import type { DaemonState } from './state.js';

/**
 * Element query action handlers
 * Translate from cli/src/native/element.rs helper functions
 */

export async function handleGettext(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  try {
    const text = await getElementText(
      mgr.client,
      sessionId,
      state.refMap,
      selector,
      state.iframeSessions
    );
    const url = await mgr.getUrl().catch(() => '');
    return { id, success: true, data: { text, origin: url } };
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }
}

export async function handleGetattribute(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  const attribute = cmd.attribute;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }
  if (!attribute || typeof attribute !== 'string') {
    return { id, success: false, error: "Missing 'attribute' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  try {
    const value = await getElementAttribute(
      mgr.client,
      sessionId,
      state.refMap,
      selector,
      attribute,
      state.iframeSessions
    );
    const url = await mgr.getUrl().catch(() => '');
    return { id, success: true, data: { value, origin: url } };
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }
}

export async function handleIsvisible(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  try {
    const visible = await isElementVisible(
      mgr.client,
      sessionId,
      state.refMap,
      selector,
      state.iframeSessions
    );
    const url = await mgr.getUrl().catch(() => '');
    return { id, success: true, data: { visible, origin: url } };
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }
}

export async function handleIsenabled(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  try {
    const enabled = await isElementEnabled(
      mgr.client,
      sessionId,
      state.refMap,
      selector,
      state.iframeSessions
    );
    const url = await mgr.getUrl().catch(() => '');
    return { id, success: true, data: { enabled, origin: url } };
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }
}

export async function handleIschecked(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  try {
    const checked = await isElementChecked(
      mgr.client,
      sessionId,
      state.refMap,
      selector,
      state.iframeSessions
    );
    const url = await mgr.getUrl().catch(() => '');
    return { id, success: true, data: { checked, origin: url } };
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }
}

export async function handleCount(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  try {
    const count = await countElements(mgr.client, sessionId, selector);
    return { id, success: true, data: { count } };
  } catch (error: any) {
    return { id, success: false, error: error.message || String(error) };
  }
}

// Element utility functions

async function resolveElementObjectId(
  client: any,
  sessionId: string,
  refMap: any,
  selectorOrRef: string,
  iframeSessions: Map<string, string>
): Promise<{ objectId: string; effectiveSessionId: string }> {
  // Parse ref (e0, @e1, ref=e2)
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new Error(`Unknown ref: ${refId}`);
    }

    const effectiveSessionId = resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions
    );

    // Try cached backend_node_id first (fast path)
    if (entry.backendNodeId) {
      try {
        const { object } = await client.sendCommand(
          'DOM.resolveNode',
          { backendNodeId: entry.backendNodeId },
          effectiveSessionId
        );
        if (object?.objectId) {
          return { objectId: object.objectId, effectiveSessionId };
        }
      } catch (e) {
        // backend_node_id is stale; re-query the accessibility tree below
      }
    }

    // Fallback: re-query the accessibility tree to find a fresh node by role/name
    const freshId = await findNodeIdByRoleName(
      client,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions
    );
    const { object } = await client.sendCommand(
      'DOM.resolveNode',
      { backendNodeId: freshId },
      effectiveSessionId
    );
    if (!object?.objectId) {
      throw new Error(`No objectId for ref ${refId}`);
    }
    return { objectId: object.objectId, effectiveSessionId };
  }

  // Selector fallback (CSS or XPath)
  const js = buildFindElementJs(selectorOrRef);
  const result = await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: js,
      returnByValue: false,
      awaitPromise: false,
    },
    sessionId
  );

  if (!result?.result?.objectId) {
    throw new Error(`Element not found: ${selectorOrRef}`);
  }
  return { objectId: result.result.objectId, effectiveSessionId: sessionId };
}

function parseRef(input: string): string | null {
  const trimmed = input.trim();

  // @e123
  if (trimmed.startsWith('@') && trimmed.length > 2) {
    const stripped = trimmed.slice(1);
    if (stripped.startsWith('e') && /^\d+$/.test(stripped.slice(1))) {
      return stripped;
    }
  }

  // ref=e123
  if (trimmed.startsWith('ref=') && trimmed.length > 5) {
    const stripped = trimmed.slice(4);
    if (stripped.startsWith('e') && /^\d+$/.test(stripped.slice(1))) {
      return stripped;
    }
  }

  // e123
  if (trimmed.startsWith('e') && trimmed.length > 1 && /^\d+$/.test(trimmed.slice(1))) {
    return trimmed;
  }

  return null;
}

function resolveFrameSession(
  frameId: string | null | undefined,
  sessionId: string,
  iframeSessions: Map<string, string>
): string {
  if (frameId) {
    const iframeSession = iframeSessions.get(frameId);
    if (iframeSession) {
      return iframeSession;
    }
  }
  return sessionId;
}

function buildFindElementJs(selector: string): string {
  if (selector.startsWith('xpath=')) {
    const xpath = selector.slice(6);
    return `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  return `document.querySelector(${JSON.stringify(selector)})`;
}

function buildCountElementsJs(selector: string): string {
  if (selector.startsWith('xpath=')) {
    const xpath = selector.slice(6);
    return `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength`;
  }
  return `document.querySelectorAll(${JSON.stringify(selector)}).length`;
}

async function findNodeIdByRoleName(
  client: any,
  sessionId: string,
  role: string,
  name: string,
  nth: number | null | undefined,
  frameId: string | null | undefined,
  iframeSessions: Map<string, string>
): Promise<number> {
  const { axParams, effectiveSessionId } = resolveAxSession(
    frameId,
    sessionId,
    iframeSessions
  );

  const axTree = await client.sendCommand(
    'Accessibility.getFullAXTree',
    axParams,
    effectiveSessionId
  );

  const nthIndex = nth ?? 0;
  let matchCount = 0;

  for (const node of axTree.nodes || []) {
    if (node.ignored) continue;
    const nodeRole = extractAxString(node.role);
    const nodeName = extractAxString(node.name);
    if (nodeRole === role && nodeName === name) {
      if (matchCount === nthIndex) {
        if (!node.backendDOMNodeId) {
          throw new Error(
            `AX node has no backendDOMNodeId for role=${role} name=${name}`
          );
        }
        return node.backendDOMNodeId;
      }
      matchCount++;
    }
  }

  throw new Error(`Could not locate element with role=${role} name=${name}`);
}

function resolveAxSession(
  frameId: string | null | undefined,
  sessionId: string,
  iframeSessions: Map<string, string>
): { axParams: any; effectiveSessionId: string } {
  if (frameId) {
    const iframeSession = iframeSessions.get(frameId);
    if (iframeSession) {
      return { axParams: {}, effectiveSessionId: iframeSession };
    }
    return { axParams: { frameId }, effectiveSessionId: sessionId };
  }
  return { axParams: {}, effectiveSessionId: sessionId };
}

function extractAxString(value: any): string {
  if (!value) return '';
  if (typeof value.value === 'string') return value.value;
  if (typeof value.value === 'number') return String(value.value);
  if (typeof value.value === 'boolean') return String(value.value);
  return '';
}

async function getElementText(
  client: any,
  sessionId: string,
  refMap: any,
  selectorOrRef: string,
  iframeSessions: Map<string, string>
): Promise<string> {
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    client,
    sessionId,
    refMap,
    selectorOrRef,
    iframeSessions
  );

  const result = await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: "function() { return this.innerText || this.textContent || ''; }",
      objectId,
      returnByValue: true,
      awaitPromise: false,
    },
    effectiveSessionId
  );

  return result?.result?.value || '';
}

async function getElementAttribute(
  client: any,
  sessionId: string,
  refMap: any,
  selectorOrRef: string,
  attribute: string,
  iframeSessions: Map<string, string>
): Promise<any> {
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    client,
    sessionId,
    refMap,
    selectorOrRef,
    iframeSessions
  );

  const result = await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: `function() { return this.getAttribute(${JSON.stringify(attribute)}); }`,
      objectId,
      returnByValue: true,
      awaitPromise: false,
    },
    effectiveSessionId
  );

  return result?.result?.value !== undefined ? result.result.value : null;
}

async function isElementVisible(
  client: any,
  sessionId: string,
  refMap: any,
  selectorOrRef: string,
  iframeSessions: Map<string, string>
): Promise<boolean> {
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    client,
    sessionId,
    refMap,
    selectorOrRef,
    iframeSessions
  );

  const result = await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: `function() {
        const rect = this.getBoundingClientRect();
        const style = window.getComputedStyle(this);
        return rect.width > 0 && rect.height > 0 &&
               style.visibility !== 'hidden' &&
               style.display !== 'none' &&
               parseFloat(style.opacity) > 0;
      }`,
      objectId,
      returnByValue: true,
      awaitPromise: false,
    },
    effectiveSessionId
  );

  return result?.result?.value === true;
}

async function isElementEnabled(
  client: any,
  sessionId: string,
  refMap: any,
  selectorOrRef: string,
  iframeSessions: Map<string, string>
): Promise<boolean> {
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    client,
    sessionId,
    refMap,
    selectorOrRef,
    iframeSessions
  );

  const result = await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: 'function() { return !this.disabled; }',
      objectId,
      returnByValue: true,
      awaitPromise: false,
    },
    effectiveSessionId
  );

  return result?.result?.value !== false;
}

async function isElementChecked(
  client: any,
  sessionId: string,
  refMap: any,
  selectorOrRef: string,
  iframeSessions: Map<string, string>
): Promise<boolean> {
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    client,
    sessionId,
    refMap,
    selectorOrRef,
    iframeSessions
  );

  const result = await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: `function() {
        var el = this;
        var tag = el.tagName && el.tagName.toUpperCase();
        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          return el.checked;
        }
        var ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;
        if (tag === 'LABEL' && el.control) {
          el = el.control;
          if (el.type === 'checkbox' || el.type === 'radio') {
            return el.checked;
          }
        }
        var input = el.querySelector('input[type="checkbox"], input[type="radio"]');
        if (input) return input.checked;
        return false;
      }`,
      objectId,
      returnByValue: true,
      awaitPromise: false,
    },
    effectiveSessionId
  );

  return result?.result?.value === true;
}

async function countElements(
  client: any,
  sessionId: string,
  selector: string
): Promise<number> {
  const js = buildCountElementsJs(selector);
  const result = await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: js,
      returnByValue: true,
      awaitPromise: false,
    },
    sessionId
  );

  return result?.result?.value || 0;
}
