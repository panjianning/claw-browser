import type { CdpClient } from './client.js';

// ============================================================================
// Network Utility Functions
// ============================================================================

/**
 * Set custom HTTP headers for all requests.
 */
export async function setExtraHeaders(
  client: CdpClient,
  sessionId: string,
  headers: Record<string, string>
): Promise<void> {
  await client.sendCommand('Network.setExtraHTTPHeaders', { headers }, sessionId);
}

/**
 * Emulate offline mode.
 */
export async function setOffline(
  client: CdpClient,
  sessionId: string,
  offline: boolean
): Promise<void> {
  await client.sendCommand(
    'Network.emulateNetworkConditions',
    {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    },
    sessionId
  );
}

/**
 * Set the document HTML content.
 */
export async function setContent(
  client: CdpClient,
  sessionId: string,
  html: string
): Promise<void> {
  await client.sendCommand('Page.setDocumentContent', { html }, sessionId);
}

// ============================================================================
// Domain Filter
// ============================================================================

/**
 * Domain filter with wildcard pattern support.
 * Patterns can be:
 * - Exact domain: "example.com"
 * - Wildcard subdomain: "*.example.com"
 */
export class DomainFilter {
  private domains: Set<string>;
  private wildcards: string[];

  constructor(patterns: string[]) {
    this.domains = new Set<string>();
    this.wildcards = [];

    for (const pattern of patterns) {
      if (pattern.startsWith('*.')) {
        this.wildcards.push(pattern.slice(2)); // Remove "*."
      } else {
        this.domains.add(pattern);
      }
    }
  }

  /**
   * Check if a domain is allowed by the filter.
   */
  isAllowed(domain: string): boolean {
    // Exact match
    if (this.domains.has(domain)) {
      return true;
    }

    // Wildcard match: "api.example.com" matches "*.example.com"
    for (const suffix of this.wildcards) {
      if (domain.endsWith(suffix)) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Install domain filter for WebSocket, EventSource, sendBeacon, and Fetch API.
 * Two-layer filtering:
 * 1. JavaScript patching (WebSocket, EventSource, sendBeacon)
 * 2. Fetch domain interception via Fetch.enable
 */
export async function installDomainFilter(
  client: CdpClient,
  sessionId: string,
  domains: string[]
): Promise<void> {
  const filter = new DomainFilter(domains);

  // Layer 1: Patch WebSocket, EventSource, sendBeacon
  const patchJs = `
    (function() {
      const isAllowed = (domain) => {
        const exact = new Set(${JSON.stringify([...filter['domains']])});
        const wildcards = ${JSON.stringify(filter['wildcards'])};

        if (exact.has(domain)) return true;

        for (const suffix of wildcards) {
          if (domain.endsWith(suffix)) return true;
        }

        return false;
      };

      const extractDomain = (url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return null;
        }
      };

      // Patch WebSocket
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = function(url, protocols) {
        const domain = extractDomain(url);
        if (domain && !isAllowed(domain)) {
          throw new Error(\`WebSocket blocked by domain filter: \${domain}\`);
        }
        return new OriginalWebSocket(url, protocols);
      };
      window.WebSocket.prototype = OriginalWebSocket.prototype;

      // Patch EventSource
      const OriginalEventSource = window.EventSource;
      window.EventSource = function(url, eventSourceInitDict) {
        const domain = extractDomain(url);
        if (domain && !isAllowed(domain)) {
          throw new Error(\`EventSource blocked by domain filter: \${domain}\`);
        }
        return new OriginalEventSource(url, eventSourceInitDict);
      };
      window.EventSource.prototype = OriginalEventSource.prototype;

      // Patch sendBeacon
      const originalSendBeacon = navigator.sendBeacon;
      navigator.sendBeacon = function(url, data) {
        const domain = extractDomain(url);
        if (domain && !isAllowed(domain)) {
          console.warn(\`sendBeacon blocked by domain filter: \${domain}\`);
          return false;
        }
        return originalSendBeacon.call(navigator, url, data);
      };
    })();
  `;

  await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: patchJs,
      returnByValue: false,
      awaitPromise: false,
    },
    sessionId
  );

  // Layer 2: Enable Fetch API interception
  await client.sendCommand(
    'Fetch.enable',
    {
      patterns: [{ requestStage: 'Request' }],
    },
    sessionId
  );

  // Subscribe to Fetch.requestPaused events
  const handleFetchRequest = async (params: any) => {
    const { requestId, request } = params;

    try {
      const url = new URL(request.url);
      const domain = url.hostname;

      if (!filter.isAllowed(domain)) {
        // Reject the request
        await client.sendCommand(
          'Fetch.failRequest',
          {
            requestId,
            errorReason: 'BlockedByClient',
          },
          sessionId
        );
      } else {
        // Continue the request
        await client.sendCommand('Fetch.continueRequest', { requestId }, sessionId);
      }
    } catch {
      // Invalid URL or other error, continue the request
      await client.sendCommand('Fetch.continueRequest', { requestId }, sessionId);
    }
  };

  client.on('Fetch.requestPaused', handleFetchRequest);
}

// ============================================================================
// Console Argument Formatting
// ============================================================================

/**
 * Format a CDP RemoteObject to a human-readable string.
 */
export function formatConsoleArg(arg: any): string | null {
  // Primitives with value field
  if (arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean') {
    if (arg.value !== undefined) {
      return arg.type === 'string' ? arg.value : String(arg.value);
    }
  }

  // null
  if (arg.type === 'object' && arg.subtype === 'null') {
    return 'null';
  }

  // undefined
  if (arg.type === 'undefined') {
    return 'undefined';
  }

  // Objects with preview
  if (arg.type === 'object' && arg.preview) {
    return formatObjectPreview(arg);
  }

  // Fallback to description
  if (arg.description) {
    return arg.description;
  }

  return null;
}

/**
 * Format an object preview.
 */
function formatObjectPreview(arg: any): string {
  const preview = arg.preview;

  // Map/Set: Use description directly
  if (preview.subtype === 'map' || preview.subtype === 'set') {
    return arg.description || 'Object';
  }

  // Array
  if (preview.subtype === 'array') {
    const elements = preview.properties
      .map((prop: any) => formatPreviewProperty(prop))
      .join(', ');
    return `[${elements}]`;
  }

  // Regular object
  const props = preview.properties.map((prop: any) => {
    const key = prop.name;
    const value = formatPreviewProperty(prop);
    return `${key}: ${value}`;
  });

  const inner = props.join(', ');
  return preview.overflow ? `{${inner}, ...}` : `{${inner}}`;
}

/**
 * Format a preview property.
 */
function formatPreviewProperty(prop: any): string {
  if (prop.type === 'string') {
    return `"${prop.value}"`;
  }
  return prop.value || 'undefined';
}

/**
 * Format multiple console arguments into a single string.
 */
export function formatConsoleArgs(args: any[]): string {
  return args
    .map(formatConsoleArg)
    .filter((s) => s !== null)
    .join(' ');
}

// ============================================================================
// Event Tracker
// ============================================================================

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  lineNumber?: number;
  args?: any[];
}

export interface ErrorEntry {
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * Track console messages and JavaScript errors.
 */
export class EventTracker {
  consoleEntries: ConsoleEntry[];
  errorEntries: ErrorEntry[];
  private readonly maxEntries = 1000;

  constructor() {
    this.consoleEntries = [];
    this.errorEntries = [];
  }

  /**
   * Add a console message.
   */
  addConsole(level: string, text: string, rawArgs: any[] = [], url?: string, lineNumber?: number) {
    if (this.consoleEntries.length >= this.maxEntries) {
      return;
    }

    const entry: ConsoleEntry = { level, text };
    if (url) entry.url = url;
    if (lineNumber !== undefined) entry.lineNumber = lineNumber;
    if (rawArgs.length > 0) entry.args = rawArgs;

    this.consoleEntries.push(entry);
  }

  /**
   * Add a JavaScript error.
   */
  addError(text: string, url?: string, lineNumber?: number, columnNumber?: number) {
    if (this.errorEntries.length >= this.maxEntries) {
      return;
    }

    const entry: ErrorEntry = { text };
    if (url) entry.url = url;
    if (lineNumber !== undefined) entry.lineNumber = lineNumber;
    if (columnNumber !== undefined) entry.columnNumber = columnNumber;

    this.errorEntries.push(entry);
  }

  /**
   * Get console messages as JSON.
   */
  getConsoleJson(): any {
    return {
      messages: this.consoleEntries.map((entry) => {
        const msg: any = { level: entry.level, text: entry.text };
        if (entry.url) msg.url = entry.url;
        if (entry.lineNumber !== undefined) msg.lineNumber = entry.lineNumber;
        if (entry.args && entry.args.length > 0) msg.args = entry.args;
        return msg;
      }),
    };
  }

  /**
   * Get error entries as JSON.
   */
  getErrorsJson(): any {
    return {
      errors: this.errorEntries,
    };
  }

  /**
   * Clear all entries.
   */
  clear() {
    this.consoleEntries = [];
    this.errorEntries = [];
  }
}
