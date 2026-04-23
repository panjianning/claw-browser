import type { DaemonState } from './state.js';

type ResolvedElement = {
  objectId: string;
  effectiveSessionId: string;
};

export async function handleClick(cmd: any, state: DaemonState): Promise<any> {
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
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );

  if (cmd.newTab === true) {
    const hrefResult = await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function() { const h = this.getAttribute('href'); if (!h) return null; try { return new URL(h, document.baseURI).toString(); } catch { return null; } }",
        returnByValue: true,
      },
      effectiveSessionId
    );
    const href = hrefResult?.result?.value;
    if (!href) {
      return {
        id,
        success: false,
        error: `Element '${selector}' does not have an href attribute`,
      };
    }
    const newPage = await mgr.createNewPage();
    mgr.setActivePageByTargetId(newPage.targetId);
    await mgr.navigate(href);
    state.refMap.clear();
    return { id, success: true, data: { clicked: selector, newTab: true, url: href, tabId: mgr.activeTargetId?.() || '' } };
  }

  const button = cmd.button || 'left';
  const clickCount = cmd.clickCount || 1;

  if (button === 'left' && clickCount === 1) {
    const domClicked = await tryDomClickOnAboutBlank(mgr.client, objectId, effectiveSessionId);
    if (domClicked) {
      return { id, success: true, data: { clicked: selector } };
    }
  }

  const point = await getElementCenter(mgr.client, objectId, effectiveSessionId);

  await mgr.client.sendCommand(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: point.x, y: point.y },
    effectiveSessionId
  );
  await mgr.client.sendCommand(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: point.x, y: point.y, button, clickCount },
    effectiveSessionId
  );
  await mgr.client.sendCommand(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount },
    effectiveSessionId
  );

  return { id, success: true, data: { clicked: selector } };
}

export async function handleDblclick(cmd: any, state: DaemonState): Promise<any> {
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

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );

  await mgr.client.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(value) {
        if (this.focus) this.focus();
        if ('value' in this) this.value = value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value: String(value) }],
    },
    effectiveSessionId
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
  if (typeof text !== 'string') {
    return { id, success: false, error: "Missing 'text' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );

  await focusObject(mgr.client, objectId, effectiveSessionId);
  for (const char of text) {
    await mgr.client.sendCommand(
      'Input.dispatchKeyEvent',
      { type: 'char', text: char },
      effectiveSessionId
    );
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
  const parsed = parseKeyChord(key);
  const params: any = {
    key: parsed.actualKey,
    code: parsed.code,
    modifiers: parsed.modifiers,
    windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
    nativeVirtualKeyCode: parsed.nativeVirtualKeyCode,
    text: parsed.text,
    unmodifiedText: parsed.unmodifiedText,
  };
  await mgr.client.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown' }, sessionId);
  await mgr.client.sendCommand(
    'Input.dispatchKeyEvent',
    {
      key: parsed.actualKey,
      code: parsed.code,
      modifiers: parsed.modifiers,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      nativeVirtualKeyCode: parsed.nativeVirtualKeyCode,
      type: 'keyUp',
    },
    sessionId
  );
  return { id, success: true, data: { pressed: key } };
}

export async function handleKeydown(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const key = cmd.key;
  if (!key || typeof key !== 'string') return { id, success: false, error: "Missing 'key' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const parsed = parseKeyChord(key);
  await mgr.client.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: parsed.actualKey,
      code: parsed.code,
      modifiers: parsed.modifiers,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      nativeVirtualKeyCode: parsed.nativeVirtualKeyCode,
      text: parsed.text,
      unmodifiedText: parsed.unmodifiedText,
    },
    sessionId
  );
  return { id, success: true, data: { keyDown: key } };
}

export async function handleKeyup(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const key = cmd.key;
  if (!key || typeof key !== 'string') return { id, success: false, error: "Missing 'key' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const parsed = parseKeyChord(key);
  await mgr.client.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: parsed.actualKey,
      code: parsed.code,
      modifiers: parsed.modifiers,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      nativeVirtualKeyCode: parsed.nativeVirtualKeyCode,
    },
    sessionId
  );
  return { id, success: true, data: { keyUp: key } };
}

export async function handleKeyboard(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const text = typeof cmd.text === 'string' ? cmd.text : '';
  if (!text) return { id, success: false, error: 'Missing keyboard text' };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  if (cmd.subaction === 'insertText') {
    await mgr.client.sendCommand('Input.insertText', { text }, sessionId);
  } else {
    for (const char of text) {
      await mgr.client.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: char }, sessionId);
    }
  }
  return { id, success: true, data: { typed: text } };
}

export async function handleHover(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') {
    return { id, success: false, error: "Missing 'selector' parameter" };
  }
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );
  const point = await getElementCenter(mgr.client, objectId, effectiveSessionId);
  await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, effectiveSessionId);
  return { id, success: true, data: { hovered: selector } };
}

export async function handleScroll(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';

  let dx = cmd.x || 0;
  let dy = cmd.y || 0;
  const amount = cmd.amount || 300;
  switch (cmd.direction) {
    case 'up': dy = -amount; break;
    case 'down': dy = amount; break;
    case 'left': dx = -amount; break;
    case 'right': dx = amount; break;
  }

  if (cmd.selector) {
    const { objectId, effectiveSessionId } = await resolveElementObjectId(
      mgr.client,
      sessionId,
      state.refMap,
      cmd.selector,
      state.iframeSessions
    );
    await mgr.client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: 'function(dx, dy) { this.scrollBy(dx, dy); }',
        arguments: [{ value: dx }, { value: dy }],
      },
      effectiveSessionId
    );
  } else {
    await mgr.client.sendCommand('Runtime.evaluate', { expression: `window.scrollBy(${dx}, ${dy})` }, sessionId);
  }

  return { id, success: true, data: { scrolled: true } };
}

export async function handleFocus(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') return { id, success: false, error: "Missing 'selector' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );
  await focusObject(mgr.client, objectId, effectiveSessionId);
  return { id, success: true, data: { focused: selector } };
}

export async function handleCheck(cmd: any, state: DaemonState): Promise<any> {
  return toggleChecked(cmd, state, true);
}

export async function handleUncheck(cmd: any, state: DaemonState): Promise<any> {
  return toggleChecked(cmd, state, false);
}

export async function handleSelect(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  const values = Array.isArray(cmd.values) ? cmd.values.map(String) : [String(cmd.values)];
  if (!selector || typeof selector !== 'string') return { id, success: false, error: "Missing 'selector' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );
  const result = await mgr.client.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(values) {
        if (this.tagName !== 'SELECT') return [];
        const selected = [];
        for (const option of this.options) {
          const hit = values.includes(option.value) || values.includes(option.text);
          option.selected = hit;
          if (hit) selected.push(option.value);
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return selected;
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
    },
    effectiveSessionId
  );
  return { id, success: true, data: { selected: result?.result?.value || [] } };
}

export async function handleScrollIntoView(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') return { id, success: false, error: "Missing 'selector' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );
  await mgr.client.sendCommand(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: "function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }" },
    effectiveSessionId
  );
  return { id, success: true, data: { scrolledIntoView: selector } };
}

export async function handleDrag(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const source = cmd.source;
  const target = cmd.target;
  if (!source || !target) return { id, success: false, error: "Missing 'source' or 'target' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const src = await resolveElementObjectId(mgr.client, sessionId, state.refMap, String(source), state.iframeSessions);
  const dst = await resolveElementObjectId(mgr.client, sessionId, state.refMap, String(target), state.iframeSessions);
  const srcPt = await getElementCenter(mgr.client, src.objectId, src.effectiveSessionId);
  const dstPt = await getElementCenter(mgr.client, dst.objectId, dst.effectiveSessionId);
  await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: srcPt.x, y: srcPt.y, button: 'left' }, src.effectiveSessionId);
  await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: srcPt.x, y: srcPt.y, button: 'left', clickCount: 1 }, src.effectiveSessionId);
  await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dstPt.x, y: dstPt.y, button: 'left' }, dst.effectiveSessionId);
  await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dstPt.x, y: dstPt.y, button: 'left', clickCount: 1 }, dst.effectiveSessionId);
  return { id, success: true, data: { dragged: true } };
}

export async function handleUpload(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  const files = Array.isArray(cmd.files) ? cmd.files.map(String) : [];
  if (!selector || typeof selector !== 'string') return { id, success: false, error: "Missing 'selector' parameter" };
  if (files.length === 0) return { id, success: false, error: "Missing 'files' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );
  const node = await mgr.client.sendCommand('DOM.requestNode', { objectId }, effectiveSessionId);
  await mgr.client.sendCommand('DOM.setFileInputFiles', { nodeId: node?.nodeId, files }, effectiveSessionId);
  return { id, success: true, data: { uploaded: files.length } };
}

export async function handleMouse(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const event = cmd.event;
  if (event === 'move') {
    const x = Number(cmd.x);
    const y = Number(cmd.y);
    state.mouseState.x = x;
    state.mouseState.y = y;
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    return { id, success: true, data: { moved: true } };
  }
  if (event === 'down') {
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.mouseState.x, y: state.mouseState.y, button: cmd.button || 'left', clickCount: 1 }, sessionId);
    return { id, success: true, data: { down: true } };
  }
  if (event === 'up') {
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.mouseState.x, y: state.mouseState.y, button: cmd.button || 'left', clickCount: 1 }, sessionId);
    return { id, success: true, data: { up: true } };
  }
  if (event === 'wheel') {
    await mgr.client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: state.mouseState.x, y: state.mouseState.y, deltaX: Number(cmd.dx || 0), deltaY: Number(cmd.dy || 0) }, sessionId);
    return { id, success: true, data: { wheel: true } };
  }
  return { id, success: false, error: `Unsupported mouse event: ${event}` };
}

type ParsedKeyChord = {
  actualKey: string;
  modifiers?: number;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  text?: string;
  unmodifiedText?: string;
};

const SPECIAL_KEY_DEFS: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  spacebar: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

function parseKeyChord(input: string): ParsedKeyChord {
  const parts = input.split('+');
  let modifiers = 0;
  const rawKey = (parts[parts.length - 1] || '').trim();
  if (!rawKey) {
    throw new Error('Missing key value');
  }

  for (let i = 0; i < parts.length - 1; i++) {
    const lower = parts[i].toLowerCase();
    if (lower === 'alt') modifiers |= 1;
    if (lower === 'control' || lower === 'ctrl') modifiers |= 2;
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers |= 4;
    if (lower === 'shift') modifiers |= 8;
  }

  const special = SPECIAL_KEY_DEFS[rawKey.toLowerCase()];
  if (special) {
    return modifiers > 0
      ? {
          actualKey: special.key,
          code: special.code,
          modifiers,
          windowsVirtualKeyCode: special.keyCode,
          nativeVirtualKeyCode: special.keyCode,
          text: special.text,
          unmodifiedText: special.text,
        }
      : {
          actualKey: special.key,
          code: special.code,
          windowsVirtualKeyCode: special.keyCode,
          nativeVirtualKeyCode: special.keyCode,
          text: special.text,
          unmodifiedText: special.text,
        };
  }

  if (rawKey.length === 1) {
    const ch = rawKey;
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const isLetter = /[a-z]/i.test(ch);
    const isDigit = /[0-9]/.test(ch);
    const keyCode = upper.charCodeAt(0);
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : undefined;
    const text = modifiers & 7 ? undefined : ch;
    return modifiers > 0
      ? {
          actualKey: isLetter ? upper : ch,
          code,
          modifiers,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
          text,
          unmodifiedText: text,
        }
      : {
          actualKey: isLetter ? upper : ch,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
          text,
          unmodifiedText: text,
        };
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(rawKey)) {
    const num = parseInt(rawKey.slice(1), 10);
    const keyCode = 111 + num;
    const normalized = `F${num}`;
    return modifiers > 0
      ? {
          actualKey: normalized,
          code: normalized,
          modifiers,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        }
      : {
          actualKey: normalized,
          code: normalized,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        };
  }

  if (/^(shift|control|ctrl|alt|meta|cmd|command)$/i.test(rawKey)) {
    const normalized = rawKey.toLowerCase();
    if (normalized === 'shift') return { actualKey: 'Shift', code: 'ShiftLeft', modifiers };
    if (normalized === 'control' || normalized === 'ctrl') return { actualKey: 'Control', code: 'ControlLeft', modifiers };
    if (normalized === 'alt') return { actualKey: 'Alt', code: 'AltLeft', modifiers };
    return { actualKey: 'Meta', code: 'MetaLeft', modifiers };
  }

  throw new Error(
    `Unknown key: ${rawKey}. Use a single character or a known key name such as Enter, Escape, Tab, ArrowUp, F1-F24.`
  );
}

async function toggleChecked(cmd: any, state: DaemonState, targetChecked: boolean): Promise<any> {
  const id = cmd.id || '';
  const selector = cmd.selector;
  if (!selector || typeof selector !== 'string') return { id, success: false, error: "Missing 'selector' parameter" };
  const mgr = state.browser;
  if (!mgr) return { id, success: false, error: 'Browser not launched' };
  const sessionId = mgr.activeSessionId?.() || '';
  const { objectId, effectiveSessionId } = await resolveElementObjectId(
    mgr.client,
    sessionId,
    state.refMap,
    selector,
    state.iframeSessions
  );
  await mgr.client.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(v) {
        if ('checked' in this) {
          this.checked = !!v;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return this.checked;
        }
        return null;
      }`,
      arguments: [{ value: targetChecked }],
      returnByValue: true,
    },
    effectiveSessionId
  );
  return { id, success: true, data: { checked: targetChecked } };
}

async function focusObject(client: any, objectId: string, sessionId: string): Promise<void> {
  await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: 'function() { if (this.focus) this.focus(); }',
    },
    sessionId
  );
}

async function getElementCenter(client: any, objectId: string, sessionId: string): Promise<{ x: number; y: number }> {
  const result = await client.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }`,
      returnByValue: true,
    },
    sessionId
  );
  const point = result?.result?.value || { x: 0, y: 0 };
  return { x: Number(point.x || 0), y: Number(point.y || 0) };
}

async function tryDomClickOnAboutBlank(client: any, objectId: string, sessionId: string): Promise<boolean> {
  try {
    const href = await client.sendCommand(
      'Runtime.evaluate',
      {
        expression: 'location.href',
        returnByValue: true,
      },
      sessionId
    );
    if (href?.result?.value !== 'about:blank') {
      return false;
    }

    await client.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
          if (typeof this.click === 'function') {
            this.click();
            return true;
          }
          this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }`,
      },
      sessionId
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveElementObjectId(
  client: any,
  sessionId: string,
  refMap: Map<string, any>,
  selector: string,
  iframeSessions: Map<string, string>
): Promise<ResolvedElement> {
  const maybeRef = normalizeRef(selector);
  if (maybeRef) {
    const entry = refMap.get(maybeRef) || refMap.get(`@${maybeRef}`) || refMap.get(selector);
    if (!entry) {
      throw new Error(`Element not found: ${selector}`);
    }
    const effectiveSessionId = resolveFrameSession(entry?.frameId, sessionId, iframeSessions);
    const backendNodeId = typeof entry === 'number'
      ? entry
      : typeof entry?.backendNodeId === 'number'
        ? entry.backendNodeId
        : await findNodeIdByRoleName(client, effectiveSessionId, entry?.role || '', entry?.name || '', entry?.nth || 0);
    const resolved = await client.sendCommand('DOM.resolveNode', { backendNodeId }, effectiveSessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
      throw new Error(`Element not found: ${selector}`);
    }
    return { objectId, effectiveSessionId };
  }

  const expr = buildFindElementJs(selector);
  const result = await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: expr,
      returnByValue: false,
      awaitPromise: false,
    },
    sessionId
  );
  const objectId = result?.result?.objectId;
  if (!objectId) {
    throw new Error(`Element not found: ${selector}`);
  }
  return { objectId, effectiveSessionId: sessionId };
}

function normalizeRef(value: string): string | null {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (/^e\d+$/i.test(candidate)) {
    return candidate.toLowerCase();
  }
  if (trimmed.startsWith('ref=')) {
    const v = trimmed.slice(4);
    if (/^e\d+$/i.test(v)) return v.toLowerCase();
  }
  return null;
}

function buildFindElementJs(selector: string): string {
  if (selector.startsWith('xpath=')) {
    const xpath = selector.slice(6);
    return `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  return `document.querySelector(${JSON.stringify(selector)})`;
}

function resolveFrameSession(frameId: string | null | undefined, defaultSessionId: string, iframeSessions: Map<string, string>): string {
  if (!frameId) return defaultSessionId;
  return iframeSessions.get(frameId) || defaultSessionId;
}

async function findNodeIdByRoleName(client: any, sessionId: string, role: string, name: string, nth: number): Promise<number> {
  const tree = await client.sendCommand('Accessibility.getFullAXTree', {}, sessionId);
  let seen = 0;
  for (const node of tree?.nodes || []) {
    if (node?.ignored) continue;
    const nodeRole = extractAxString(node.role);
    const nodeName = extractAxString(node.name);
    if (nodeRole === role && nodeName === name) {
      if (seen === nth) {
        if (typeof node.backendDOMNodeId !== 'number') break;
        return node.backendDOMNodeId;
      }
      seen++;
    }
  }
  throw new Error(`Element not found for ref role=${role} name=${name}`);
}

function extractAxString(value: any): string {
  if (!value) return '';
  if (typeof value.value === 'string') return value.value;
  if (typeof value.value === 'number') return String(value.value);
  if (typeof value.value === 'boolean') return String(value.value);
  return '';
}
