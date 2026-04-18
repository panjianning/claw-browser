import type { DaemonState } from './state.js';

/**
 * Element interaction action handlers
 *
 * NOTE: This file contains placeholder implementations that delegate to
 * the full interaction module (src/cdp/interaction.ts) which needs to be
 * translated from cli/src/native/interaction.rs
 */

export async function handleClick(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    await state.webdriverBackend.click(selector);
    return { id, success: true, data: { clicked: selector } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const newTab = cmd.newTab === true;

  if (newTab) {
    // Extract href and open in new tab
    const result = await resolveElementObjectId(
      mgr.client,
      sessionId,
      state.refMap,
      selector,
      state.iframeSessions
    );
    const { objectId, effectiveSessionId } = result;

    const callResult = await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function() { var h = this.getAttribute('href'); if (!h) return null; try { return new URL(h, document.baseURI).toString(); } catch(e) { return null; } }",
        returnByValue: true,
      },
      effectiveSessionId
    );

    const href = callResult?.result?.value;
    if (!href) {
      return {
        id,
        success: false,
        error: `Element '${selector}' does not have an href attribute. --new-tab only works on links.`,
      };
    }

    state.refMap.clear();
    await mgr.tabNew(href);

    return { id, success: true, data: { clicked: selector, newTab: true, url: href } };
  }

  const button = cmd.button || 'left';
  const clickCount = cmd.clickCount || 1;

  // TODO: Import and use full interaction.click() from src/cdp/interaction.ts
  // For now, placeholder implementation using CDP directly
  const backendNodeId = state.refMap.get(selector);
  if (!backendNodeId) {
    return { id, success: false, error: `Element not found: ${selector}` };
  }

  const { nodeId } = await mgr.client.sendCommand(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  const { model } = await mgr.client.sendCommand(
    'DOM.getBoxModel',
    { nodeId },
    sessionId
  );
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const x = (x1 + x3) / 2;
  const y = (y1 + y3) / 2;

  await mgr.client.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    },
    sessionId
  );
  await mgr.client.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    },
    sessionId
  );

  return { id, success: true, data: { clicked: selector } };
}

export async function handleDblclick(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  // Reuse click logic with clickCount=2
  return handleClick({ ...cmd, clickCount: 2 }, state);
}

export async function handleFill(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  const value = cmd.value;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }
  if (value === undefined || value === null) {
    return { id, success: false, error: "Missing 'value' parameter" };
  }

  // WebDriver backend fallback
  if (state.webdriverBackend && !state.browser) {
    await state.webdriverBackend.fill(selector, String(value));
    return { id, success: true, data: { filled: selector } };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  // TODO: Import and use full interaction.fill() from src/cdp/interaction.ts
  // Placeholder implementation
  const backendNodeId = state.refMap.get(selector);
  if (!backendNodeId) {
    return { id, success: false, error: `Element not found: ${selector}` };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const { nodeId } = await mgr.client.sendCommand(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  const { objectId } = await mgr.client.sendCommand(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  ).then((r: any) => r.object);

  await mgr.client.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(value) { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      arguments: [{ value: String(value) }],
    },
    sessionId
  );

  return { id, success: true, data: { filled: selector } };
}

export async function handleType(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  const text = cmd.text;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }
  if (!text || typeof text !== 'string') {
    return { id, success: false, error: "Missing 'text' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const clear = cmd.clear === true;
  const delay = cmd.delay;

  // TODO: Import and use full interaction.typeText() from src/cdp/interaction.ts
  // Placeholder: focus element then type
  const backendNodeId = state.refMap.get(selector);
  if (!backendNodeId) {
    return { id, success: false, error: `Element not found: ${selector}` };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const { nodeId } = await mgr.client.sendCommand(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  await mgr.client.sendCommand('DOM.focus', { nodeId }, sessionId);

  if (clear) {
    await mgr.client.sendCommand(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2, // Control
      },
      sessionId
    );
    await mgr.client.sendCommand(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Backspace' },
      sessionId
    );
  }

  for (const char of text) {
    await mgr.client.sendCommand(
      'Input.dispatchKeyEvent',
      { type: 'char', text: char },
      sessionId
    );
    if (delay) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { id, success: true, data: { typed: text } };
}

export async function handlePress(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const key = cmd.key;
  if (!key || typeof key !== 'string') {
    return { id, success: false, error: "Missing 'key' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  // Parse modifier+key chords like "Control+a", "Shift+Enter"
  const { actualKey, modifiers } = parseKeyChord(key);

  const params: any = { type: 'keyDown', key: actualKey };
  if (modifiers !== undefined) {
    params.modifiers = modifiers;
  }

  await mgr.client.sendCommand('Input.dispatchKeyEvent', params, sessionId);
  await mgr.client.sendCommand(
    'Input.dispatchKeyEvent',
    { ...params, type: 'keyUp' },
    sessionId
  );

  return { id, success: true, data: { pressed: key } };
}

export async function handleHover(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  // TODO: Import and use full interaction.hover() from src/cdp/interaction.ts
  // Placeholder: get element center and dispatch mouseMoved
  const backendNodeId = state.refMap.get(selector);
  if (!backendNodeId) {
    return { id, success: false, error: `Element not found: ${selector}` };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const { nodeId } = await mgr.client.sendCommand(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  const { model } = await mgr.client.sendCommand(
    'DOM.getBoxModel',
    { nodeId },
    sessionId
  );
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const x = (x1 + x3) / 2;
  const y = (y1 + y3) / 2;

  await mgr.client.sendCommand(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y },
    sessionId
  );

  return { id, success: true, data: { hovered: selector } };
}

export async function handleScroll(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const selector = cmd.selector;
  let dx = cmd.x || 0;
  let dy = cmd.y || 0;

  if (cmd.direction) {
    const amount = cmd.amount || 300;
    switch (cmd.direction) {
      case 'up':
        dy = -amount;
        break;
      case 'down':
        dy = amount;
        break;
      case 'left':
        dx = -amount;
        break;
      case 'right':
        dx = amount;
        break;
    }
  }

  // TODO: Import and use full interaction.scroll() from src/cdp/interaction.ts
  // Placeholder implementation
  if (selector) {
    const backendNodeId = state.refMap.get(selector);
    if (!backendNodeId) {
      return { id, success: false, error: `Element not found: ${selector}` };
    }

    const { object } = await mgr.client.sendCommand(
      'DOM.resolveNode',
      { backendNodeId },
      sessionId
    );
    await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function(dx, dy) { this.scrollBy(dx, dy); }`,
        arguments: [{ value: dx }, { value: dy }],
      },
      sessionId
    );
  } else {
    await mgr.client.sendCommand(
      'Runtime.evaluate',
      {
        expression: `window.scrollBy(${dx}, ${dy})`,
      },
      sessionId
    );
  }

  return { id, success: true, data: { scrolled: true } };
}

// Helper functions

function parseKeyChord(input: string): { actualKey: string; modifiers?: number } {
  const parts = input.split('+');
  if (parts.length < 2) {
    return { actualKey: input };
  }

  let modifiers = 0;
  const keyParts: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'alt') {
      modifiers |= 1;
    } else if (lower === 'control' || lower === 'ctrl') {
      modifiers |= 2;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
      modifiers |= 4;
    } else if (lower === 'shift') {
      modifiers |= 8;
    } else {
      keyParts.push(part);
    }
  }

  if (modifiers === 0) {
    return { actualKey: input };
  }

  const actualKey = keyParts.length === 0 ? input : keyParts.join('+');
  return { actualKey, modifiers };
}

async function resolveElementObjectId(
  client: any,
  sessionId: string,
  refMap: any,
  selector: string,
  iframeSessions: Map<string, string>
): Promise<{ objectId: string; effectiveSessionId: string }> {
  // TODO: Full implementation from cli/src/native/element.rs
  const backendNodeId = refMap.get(selector);
  if (!backendNodeId) {
    throw new Error(`Element not found: ${selector}`);
  }

  const { object } = await client.sendCommand(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );

  return { objectId: object.objectId, effectiveSessionId: sessionId };
}
