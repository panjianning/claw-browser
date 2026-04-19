import * as fs from 'fs/promises';
import * as path from 'path';
import type { CdpClient } from '../cdp/client.js';
import type { DaemonState } from './state.js';
import { getSocketDir } from '../utils/socket-dir.js';
import * as navigation from './navigation.js';
import * as interactions from './interactions.js';
import * as wait from './wait.js';

const FLOW_BINDING_NAME = '__clawFlowPush';
const FLOW_VERSION = 1;

type FlowStepAction =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'press'
  | 'wait'
  | 'wait_for_url';

export interface FlowStep {
  action: FlowStepAction;
  selector?: string;
  candidates?: string[];
  value?: string;
  key?: string;
  url?: string;
  pattern?: string;
  timeoutMs?: number;
  sensitive?: boolean;
}

interface FlowFile {
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  steps: FlowStep[];
}

interface FlowRecordingRuntime {
  name: string;
  startedAtMs: number;
  steps: FlowStep[];
  sessionId: string;
  tabId: string | null;
  client: CdpClient;
  bindingHandler: (params: any, incomingSessionId?: string) => void;
  scriptIdentifier: string | null;
}

interface RecordedEvent {
  t: string;
  ts?: number;
  url?: string;
  selector?: string;
  candidates?: string[];
  value?: string;
  key?: string;
}

const flowRuntimeByState = new WeakMap<DaemonState, FlowRecordingRuntime>();

function ok(id: string, data: Record<string, unknown>): any {
  return { id, success: true, data };
}

function fail(id: string, error: string): any {
  return { id, success: false, error };
}

function getFlowDir(): string {
  return path.join(getSocketDir(), 'flows');
}

function validateFlowName(name: string): string {
  const value = name.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error('Invalid flow name. Use [A-Za-z0-9._-], max length 128.');
  }
  return value;
}

function getFlowPath(name: string): string {
  return path.join(getFlowDir(), `${validateFlowName(name)}.json`);
}

async function ensureFlowDir(): Promise<void> {
  await fs.mkdir(getFlowDir(), { recursive: true });
}

async function readFlow(name: string): Promise<FlowFile> {
  const p = getFlowPath(name);
  const raw = await fs.readFile(p, 'utf-8');
  const parsed = JSON.parse(raw) as FlowFile;
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error(`Invalid flow file: ${p}`);
  }
  return parsed;
}

function stringifyFlow(flow: FlowFile): string {
  return JSON.stringify(flow, null, 2);
}

function toSelectorCandidateList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x) => typeof x === 'string' && x.trim().length > 0);
}

function mapRecordedEventToStep(event: RecordedEvent): FlowStep | null {
  if (event.t === 'navigate' && typeof event.url === 'string' && event.url.length > 0) {
    return { action: 'navigate', url: event.url };
  }
  if (event.t === 'click') {
    const candidates = toSelectorCandidateList(event.candidates);
    const selector = typeof event.selector === 'string' ? event.selector : (candidates[0] || '');
    if (!selector) return null;
    return { action: 'click', selector, candidates };
  }
  if (event.t === 'change') {
    const candidates = toSelectorCandidateList(event.candidates);
    const selector = typeof event.selector === 'string' ? event.selector : (candidates[0] || '');
    if (!selector) return null;
    return {
      action: 'fill',
      selector,
      candidates,
      value: typeof event.value === 'string' ? event.value : '',
    };
  }
  if (event.t === 'keydown' && typeof event.key === 'string' && event.key.length > 0) {
    return { action: 'press', key: event.key };
  }
  return null;
}

function stepsEqual(a: FlowStep, b: FlowStep): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushStep(runtime: FlowRecordingRuntime, step: FlowStep): void {
  const last = runtime.steps.length > 0 ? runtime.steps[runtime.steps.length - 1] : null;
  if (!last || !stepsEqual(last, step)) {
    runtime.steps.push(step);
  }
}

function getActiveRuntime(state: DaemonState): FlowRecordingRuntime | null {
  return flowRuntimeByState.get(state) || null;
}

function recordingScriptSource(): string {
  return `(() => {
  const BINDING = '${FLOW_BINDING_NAME}';
  const g = globalThis;
  if (g.__clawFlowInstalled) return;
  g.__clawFlowInstalled = true;

  const cssEscape = (value) => {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c);
  };

  const escAttr = (value) => String(value).replace(/"/g, '\\\\\\"');
  const attrSel = (name, value) => '[' + name + '="' + escAttr(value) + '"]';

  const push = (event) => {
    try {
      const fn = g[BINDING];
      if (typeof fn === 'function') {
        fn(JSON.stringify({ ...event, ts: Date.now() }));
      }
    } catch {}
  };

  const cssPath = (el) => {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      let part = tag;
      if (node.id) {
        part = '#' + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      let idx = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling) != null) {
        if (sib.tagName === node.tagName) idx++;
      }
      part += ':nth-of-type(' + idx + ')';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const candidates = (el) => {
    const list = [];
    if (!(el instanceof Element)) return list;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) list.push(attrSel('data-testid', testId));
    const id = el.getAttribute('id');
    if (id) list.push('#' + cssEscape(id));
    const name = el.getAttribute('name');
    if (name) list.push(tag + attrSel('name', name));
    const aria = el.getAttribute('aria-label');
    if (aria) list.push(tag + attrSel('aria-label', aria));
    const role = el.getAttribute('role');
    if (role) list.push(tag + attrSel('role', role));
    const fallback = cssPath(el);
    if (fallback) list.push(fallback);
    return Array.from(new Set(list)).slice(0, 5);
  };

  let lastUrl = location.href;
  push({ t: 'navigate', url: lastUrl });
  const maybePushUrl = () => {
    const current = location.href;
    if (current !== lastUrl) {
      lastUrl = current;
      push({ t: 'navigate', url: current });
    }
  };

  const oldPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    const ret = oldPushState(...args);
    setTimeout(maybePushUrl, 0);
    return ret;
  };
  const oldReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    const ret = oldReplaceState(...args);
    setTimeout(maybePushUrl, 0);
    return ret;
  };

  addEventListener('popstate', maybePushUrl, true);
  addEventListener('hashchange', maybePushUrl, true);
  addEventListener('pageshow', maybePushUrl, true);
  addEventListener('load', maybePushUrl, true);

  document.addEventListener('click', (evt) => {
    const target = evt.target instanceof Element ? evt.target : null;
    if (!target) return;
    const cands = candidates(target);
    if (cands.length === 0) return;
    push({ t: 'click', selector: cands[0], candidates: cands, url: location.href });
  }, true);

  document.addEventListener('change', (evt) => {
    const target = evt.target instanceof Element ? evt.target : null;
    if (!target) return;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }
    const cands = candidates(target);
    if (cands.length === 0) return;
    const value = target instanceof HTMLInputElement && target.type === 'password' ? '' : String(target.value ?? '');
    push({ t: 'change', selector: cands[0], candidates: cands, value, url: location.href });
  }, true);

  document.addEventListener('keydown', (evt) => {
    const key = String(evt.key || '');
    if (key !== 'Enter' && key !== 'Escape' && key !== 'Tab') return;
    push({ t: 'keydown', key, url: location.href });
  }, true);
})();`;
}

async function detachRecorder(runtime: FlowRecordingRuntime): Promise<void> {
  runtime.client.off('Runtime.bindingCalled', runtime.bindingHandler);
  if (runtime.scriptIdentifier) {
    try {
      await runtime.client.sendCommand(
        'Page.removeScriptToEvaluateOnNewDocument',
        { identifier: runtime.scriptIdentifier },
        runtime.sessionId
      );
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export async function handleFlowRecord(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  if (getActiveRuntime(state)) {
    return fail(id, 'A flow recording is already active. Run flow stop first.');
  }

  const rawName = typeof cmd.name === 'string' ? cmd.name : '';
  if (!rawName.trim()) {
    return fail(id, "Missing flow name. Usage: flow record <name> [--url <url>]");
  }

  const name = validateFlowName(rawName);
  const mgr = state.browser;
  if (!mgr) {
    return fail(id, 'Browser not launched');
  }

  const sessionId = mgr.activeSessionId?.() || '';
  const tabId = typeof mgr.activeTargetId === 'function' ? mgr.activeTargetId() : null;
  const client: CdpClient = mgr.client;
  const script = recordingScriptSource();

  const runtime: FlowRecordingRuntime = {
    name,
    startedAtMs: Date.now(),
    steps: [],
    sessionId,
    tabId,
    client,
    bindingHandler: () => {},
    scriptIdentifier: null,
  };

  const bindingHandler = (params: any, incomingSessionId?: string) => {
    if (incomingSessionId && runtime.sessionId && incomingSessionId !== runtime.sessionId) {
      return;
    }
    if (params?.name !== FLOW_BINDING_NAME) {
      return;
    }
    if (typeof params?.payload !== 'string') {
      return;
    }
    try {
      const event = JSON.parse(params.payload) as RecordedEvent;
      const step = mapRecordedEventToStep(event);
      if (step) {
        pushStep(runtime, step);
      }
    } catch {
      // Ignore malformed payload.
    }
  };
  runtime.bindingHandler = bindingHandler;

  try {
    client.on('Runtime.bindingCalled', bindingHandler);
    await client.sendCommand('Runtime.addBinding', { name: FLOW_BINDING_NAME }, sessionId);
    const addScript = await client.sendCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: script },
      sessionId
    );
    runtime.scriptIdentifier =
      addScript && typeof (addScript as any).identifier === 'string'
        ? (addScript as any).identifier
        : null;

    await client
      .sendCommand(
        'Runtime.evaluate',
        {
          expression: script,
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId
      )
      .catch(() => {});

    if (typeof cmd.url === 'string' && cmd.url.trim().length > 0) {
      const navRes = await navigation.handleNavigate(
        { id: `${id}-navigate`, action: 'navigate', url: cmd.url.trim() },
        state
      );
      if (!navRes?.success) {
        await detachRecorder(runtime);
        return fail(id, navRes?.error || 'Failed to navigate while starting recording');
      }
      pushStep(runtime, { action: 'navigate', url: cmd.url.trim() });
    }

    flowRuntimeByState.set(state, runtime);
    return ok(id, {
      recording: true,
      name,
      tabId,
      startedAt: new Date(runtime.startedAtMs).toISOString(),
    });
  } catch (error: any) {
    await detachRecorder(runtime).catch(() => {});
    return fail(id, error?.message || String(error));
  }
}

export async function handleFlowStop(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const runtime = getActiveRuntime(state);
  if (!runtime) {
    return fail(id, 'No active flow recording.');
  }

  flowRuntimeByState.delete(state);

  try {
    await detachRecorder(runtime);
    await ensureFlowDir();
    const now = new Date().toISOString();
    const flow: FlowFile = {
      name: runtime.name,
      version: FLOW_VERSION,
      createdAt: now,
      updatedAt: now,
      steps: runtime.steps,
    };
    const filePath = getFlowPath(runtime.name);
    await fs.writeFile(filePath, stringifyFlow(flow), 'utf-8');

    return ok(id, {
      recording: false,
      name: runtime.name,
      path: filePath,
      steps: runtime.steps.length,
      durationMs: Math.max(0, Date.now() - runtime.startedAtMs),
    });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleFlowList(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  await ensureFlowDir();
  const dir = getFlowDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const flows: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const name = entry.name.slice(0, -5);
    try {
      const filePath = path.join(dir, entry.name);
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<FlowFile>;
      const steps = Array.isArray(parsed.steps) ? parsed.steps.length : 0;
      flows.push({
        name,
        steps,
        updatedAt: parsed.updatedAt || null,
        path: filePath,
      });
    } catch {
      flows.push({ name, steps: 0, updatedAt: null, path: path.join(dir, entry.name) });
    }
  }

  flows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok(id, { flows });
}

export async function handleFlowShow(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const rawName = typeof cmd.name === 'string' ? cmd.name : '';
  if (!rawName.trim()) {
    return fail(id, "Missing flow name. Usage: flow show <name>");
  }
  try {
    const flow = await readFlow(rawName);
    return ok(id, flow as unknown as Record<string, unknown>);
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

export async function handleFlowDelete(cmd: any, _state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const rawName = typeof cmd.name === 'string' ? cmd.name : '';
  if (!rawName.trim()) {
    return fail(id, "Missing flow name. Usage: flow delete <name>");
  }
  try {
    const filePath = getFlowPath(rawName);
    await fs.unlink(filePath);
    return ok(id, { deleted: true, name: validateFlowName(rawName), path: filePath });
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }
}

function resolveTemplate(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key];
    }
    return '';
  });
}

function getSelector(step: FlowStep): string {
  if (typeof step.selector === 'string' && step.selector.trim().length > 0) {
    return step.selector;
  }
  if (Array.isArray(step.candidates) && step.candidates.length > 0) {
    return step.candidates[0];
  }
  return '';
}

async function runOneStep(
  state: DaemonState,
  flowName: string,
  step: FlowStep,
  index: number,
  vars: Record<string, string>,
  tabId: string
): Promise<any> {
  const stepId = `flow-${flowName}-${index + 1}`;
  const mgr = state.browser;
  if (!mgr) {
    return { id: stepId, success: false, error: 'Browser not launched' };
  }
  try {
    mgr.setActivePageByTargetId?.(tabId);
  } catch (error: any) {
    return { id: stepId, success: false, error: error?.message || String(error) };
  }

  switch (step.action) {
    case 'navigate': {
      const url = resolveTemplate(String(step.url || ''), vars);
      return navigation.handleNavigate({ id: stepId, action: 'navigate', url }, state);
    }
    case 'click': {
      const selector = resolveTemplate(getSelector(step), vars);
      return interactions.handleClick({ id: stepId, action: 'click', selector }, state);
    }
    case 'fill': {
      const selector = resolveTemplate(getSelector(step), vars);
      const value = resolveTemplate(String(step.value || ''), vars);
      return interactions.handleFill({ id: stepId, action: 'fill', selector, value }, state);
    }
    case 'press': {
      const key = resolveTemplate(String(step.key || ''), vars);
      return interactions.handlePress({ id: stepId, action: 'press', key }, state);
    }
    case 'wait': {
      const selector = resolveTemplate(String(step.selector || ''), vars);
      const timeout = typeof step.timeoutMs === 'number' ? step.timeoutMs : undefined;
      if (selector) {
        return wait.handleWait({ id: stepId, action: 'wait', selector, timeout }, state);
      }
      return wait.handleWait({ id: stepId, action: 'wait', timeout }, state);
    }
    case 'wait_for_url': {
      const pattern = resolveTemplate(String(step.pattern || ''), vars);
      const timeout = typeof step.timeoutMs === 'number' ? step.timeoutMs : undefined;
      return wait.handleWaitForUrl(
        { id: stepId, action: 'waitforurl', url: pattern, timeout },
        state
      );
    }
    default:
      return { id: stepId, success: false, error: `Unsupported flow action: ${String(step.action)}` };
  }
}

export async function handleFlowRun(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const rawName = typeof cmd.name === 'string' ? cmd.name : '';
  if (!rawName.trim()) {
    return fail(id, "Missing flow name. Usage: flow run <name> [--var key=value] [--close-tab]");
  }

  const vars =
    cmd.vars && typeof cmd.vars === 'object'
      ? (cmd.vars as Record<string, string>)
      : {};

  let flow: FlowFile;
  try {
    flow = await readFlow(rawName);
  } catch (error: any) {
    return fail(id, error?.message || String(error));
  }

  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    return fail(id, 'Flow has no steps.');
  }
  const firstStep = flow.steps[0];
  if (firstStep.action !== 'navigate' || typeof firstStep.url !== 'string' || !firstStep.url.trim()) {
    return fail(id, 'Flow must start with a navigate step for auto-tab run mode.');
  }

  const mgr = state.browser;
  if (!mgr) {
    return fail(id, 'Browser not launched');
  }

  const closeTabAfterRun = cmd.closeTab === true;
  let runTabId = '';
  let tabClosed = false;

  const firstUrl = resolveTemplate(String(firstStep.url), vars);

  const runLog: Array<Record<string, unknown>> = [];
  try {
    const firstStarted = Date.now();
    const newPage = await mgr.createNewPage();
    runTabId = newPage.targetId;
    mgr.setActivePageByTargetId?.(runTabId);

    const firstNavResult = await navigation.handleNavigate(
      { id: `flow-${flow.name}-1`, action: 'navigate', url: firstUrl },
      state
    );
    const firstDurationMs = Math.max(0, Date.now() - firstStarted);
    runLog.push({
      index: 1,
      action: 'navigate',
      success: Boolean(firstNavResult?.success),
      durationMs: firstDurationMs,
      tabId: runTabId,
      error: firstNavResult?.success ? null : (firstNavResult?.error || 'Unknown error'),
    });

    if (!firstNavResult?.success) {
      return fail(
        id,
        `Flow failed at step 1 (navigate): ${firstNavResult?.error || 'Unknown error'}`
      );
    }

    for (let i = 1; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const started = Date.now();
      const result = await runOneStep(state, flow.name, step, i, vars, runTabId);
      const durationMs = Math.max(0, Date.now() - started);
      runLog.push({
        index: i + 1,
        action: step.action,
        success: Boolean(result?.success),
        durationMs,
        tabId: runTabId,
        error: result?.success ? null : (result?.error || 'Unknown error'),
      });
      if (!result?.success) {
        return fail(
          id,
          `Flow failed at step ${i + 1} (${step.action}): ${result?.error || 'Unknown error'}`
        );
      }
    }

    return ok(id, {
      ran: true,
      name: flow.name,
      steps: flow.steps.length,
      tabId: runTabId,
      autoTab: true,
      closeTab: closeTabAfterRun,
      log: runLog,
    });
  } finally {
    if (closeTabAfterRun && runTabId) {
      try {
        await mgr.closePage(runTabId);
        tabClosed = true;
      } catch {
        tabClosed = false;
      }
    }
    if (tabClosed) {
      // Keep active tab stable after close.
      const pages = mgr.getPages?.() || [];
      if (pages.length > 0) {
        try {
          mgr.setActivePage(0);
        } catch {
          // Ignore.
        }
      }
    }
  }
}
