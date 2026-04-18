import type { CdpClient } from './client.js';

interface EvaluateParams {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

interface EvaluateResult {
  result: {
    value?: any;
  };
  exceptionDetails?: {
    text: string;
  };
}

export async function storageGet(
  client: CdpClient,
  sessionId: string,
  storageType: string,
  key?: string
): Promise<any> {
  const st = storageJsName(storageType);

  if (key) {
    const js = `${st}.getItem(${JSON.stringify(key)})`;
    const result = await evalSimple(client, sessionId, js);
    return { key, value: result };
  } else {
    const js = `(() => {
      const s = ${st};
      const data = {};
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        data[key] = s.getItem(key);
      }
      return data;
    })()`;
    const result = await evalSimple(client, sessionId, js);
    return { data: result };
  }
}

export async function storageSet(
  client: CdpClient,
  sessionId: string,
  storageType: string,
  key: string,
  value: string
): Promise<void> {
  const st = storageJsName(storageType);
  const js = `${st}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`;
  await evalSimple(client, sessionId, js);
}

export async function storageClear(
  client: CdpClient,
  sessionId: string,
  storageType: string
): Promise<void> {
  const st = storageJsName(storageType);
  const js = `${st}.clear()`;
  await evalSimple(client, sessionId, js);
}

function storageJsName(storageType: string): string {
  return storageType === 'session' ? 'sessionStorage' : 'localStorage';
}

async function evalSimple(client: CdpClient, sessionId: string, js: string): Promise<any> {
  const result = (await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: js,
      returnByValue: true,
      awaitPromise: false,
    } as EvaluateParams,
    sessionId
  )) as EvaluateResult;

  if (result.exceptionDetails) {
    throw new Error(`Storage error: ${result.exceptionDetails.text}`);
  }

  return result.result.value ?? null;
}
