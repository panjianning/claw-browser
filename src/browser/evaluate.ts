import type { DaemonState } from './state.js';

/**
 * JavaScript evaluation handlers.
 */
export async function handleEvaluate(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  let script = cmd.script;

  if (cmd.base64 === true && typeof cmd.scriptBase64 === 'string') {
    try {
      script = Buffer.from(cmd.scriptBase64, 'base64').toString('utf-8');
    } catch {
      return { id, success: false, error: 'Invalid base64 script payload' };
    }
  }

  if (cmd.stdin === true) {
    script = await readStdin();
  }

  if (!script || typeof script !== 'string') {
    return { id, success: false, error: "Missing 'script' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  try {
    const result = await mgr.evaluate(script);
    return { id, success: true, data: { result } };
  } catch (error: any) {
    return {
      id,
      success: false,
      error: `Evaluation error: ${error?.message || String(error)}`,
    };
  }
}

export async function handleEvalHandle(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';
  let script = cmd.script;

  if (!script || typeof script !== 'string') {
    return { id, success: false, error: "Missing 'script' parameter" };
  }

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';
  try {
    const result = await mgr.client.sendCommand(
      'Runtime.evaluate',
      {
        expression: script,
        returnByValue: false,
        awaitPromise: true,
      },
      sessionId
    );
    const objectId = result?.result?.objectId;
    if (!objectId) {
      return { id, success: false, error: 'No handle returned (primitive result)' };
    }
    return { id, success: true, data: { objectId } };
  } catch (error: any) {
    return {
      id,
      success: false,
      error: `Evaluation error: ${error?.message || String(error)}`,
    };
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
