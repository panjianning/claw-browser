import type { DaemonState } from './state.js';

/**
 * JavaScript evaluation handlers.
 */
export async function handleEvaluate(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  const script = cmd.script;

  if (!script || typeof script !== 'string') {
    return { id, success: false, error: "Missing 'script' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const result = await mgr.evaluate(script);
  return { id, success: true, data: { result } };
}
