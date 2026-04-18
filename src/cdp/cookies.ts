import type { CdpClient } from './client.js';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
}

interface GetAllCookiesResult {
  cookies: Cookie[];
}

interface GetCookiesResult {
  cookies: Cookie[];
}

export async function getAllCookies(client: CdpClient, sessionId: string): Promise<Cookie[]> {
  const result = (await client.sendCommand(
    'Network.getAllCookies',
    undefined,
    sessionId
  )) as GetAllCookiesResult;

  return result.cookies || [];
}

export async function getCookies(
  client: CdpClient,
  sessionId: string,
  urls?: string[]
): Promise<Cookie[]> {
  const params = urls && urls.length > 0 ? { urls } : {};

  const result = (await client.sendCommand(
    'Network.getCookies',
    params,
    sessionId
  )) as GetCookiesResult;

  return result.cookies || [];
}

export async function setCookies(
  client: CdpClient,
  sessionId: string,
  cookies: any[],
  currentUrl?: string
): Promise<void> {
  // Auto-fill url if no domain/path/url provided
  const processedCookies = cookies.map((c) => {
    const cookie = { ...c };
    if (!cookie.url && !cookie.domain && currentUrl) {
      cookie.url = currentUrl;
    }
    return cookie;
  });

  await client.sendCommand(
    'Network.setCookies',
    { cookies: processedCookies },
    sessionId
  );
}

export async function clearCookies(client: CdpClient, sessionId: string): Promise<void> {
  await client.sendCommand('Network.clearBrowserCookies', undefined, sessionId);
}
