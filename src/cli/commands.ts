import type { Command, Flags } from '../types/commands.js';
import {
  MissingArgumentsError,
  UnknownCommandError,
  UnknownSubcommandError,
  InvalidValueError,
} from '../types/commands.js';

const TAB_ID_OPTIONAL_ACTIONS = new Set([
  'tab_list',
  'tab_new',
  'tab_switch',
  'tab_close',
  'window_new',
  'state_list',
  'state_show',
  'state_rename',
  'state_clear',
  'state_clean',
  'inspect',
  'stream_enable',
  'stream_disable',
  'stream_status',
  'install',
  'upgrade',
  'chat',
]);

const TAB_ID_SKIP_BIND_ACTIONS = new Set([
  'launch',
  'close',
  'tab_switch',
  'tab_list',
  'tab_new',
  'tab_close',
]);

// Generate unique request ID
export function genId(): string {
  const timestamp = Date.now() * 1000 + performance.now() * 1000;
  return `r${Math.floor(timestamp % 1000000)}`;
}

// Validate session name (no path traversal or invalid characters)
export function isValidSessionName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  if (name.includes('\0') || name.includes('\n') || name.includes('\r')) {
    return false;
  }
  return name.length > 0 && name.length < 256;
}

// Parse command from CLI arguments
export function parseCommand(args: string[], flags: Flags = {}): Command {
  const result = parseCommandInner(args, flags);

  if (!flags.tabId && !TAB_ID_OPTIONAL_ACTIONS.has(result.action)) {
    const cmdText = args.join(' ');
    throw new InvalidValueError(
      'Missing required global option: --tab-id',
      `--tab-id <tab-id> ${cmdText}`.trim()
    );
  }

  // Inject default timeout into wait-family commands if not already present
  if (result.action.startsWith('wait') && !result.timeout && flags.defaultTimeout) {
    result.timeout = flags.defaultTimeout;
  }

  if (flags.tabId) {
    if (!TAB_ID_SKIP_BIND_ACTIONS.has(result.action)) {
      result.tabId = flags.tabId;
    }
  }

  return result;
}

function parseTabSelector(value: string): { index?: number; tabId?: string; shortId?: string; label?: string } {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const raw = parseInt(trimmed, 10);
    return { index: Math.max(0, raw - 1) };
  }
  if (/^t[1-9]\d*$/i.test(trimmed)) {
    return { shortId: trimmed.toLowerCase() };
  }
  if (/^[a-f0-9]{16,}$/i.test(trimmed)) {
    return { tabId: trimmed };
  }
  return { label: trimmed };
}

function normalizeUrlLikeOpen(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('about:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('chrome://')
  ) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function parseCommandInner(args: string[], flags: Flags): Command {
  if (args.length === 0) {
    throw new MissingArgumentsError('', '<command> [args...]');
  }

  const cmd = args[0];
  const rest = args.slice(1);
  const id = genId();

  // Warn if --annotate is used with non-screenshot commands
  if (flags.cliAnnotate && cmd !== 'screenshot') {
    console.warn('⚠ --annotate only applies to the screenshot command');
  }

  switch (cmd) {
    // === Navigation ===
    case 'open':
    case 'goto':
    case 'navigate': {
      if (rest.length === 0) {
        throw new MissingArgumentsError(cmd, 'open <url>');
      }
      const url = normalizeUrlLikeOpen(rest[0]);

      const navCmd: Command = { id, action: 'navigate', url };

      if (flags.provider) {
        navCmd.waitUntil = 'none';
      }

      if (flags.headers) {
        try {
          navCmd.headers = JSON.parse(flags.headers);
        } catch {
          throw new InvalidValueError(
            `Invalid JSON for --headers: ${flags.headers}`,
            'open <url> --headers \'{"Key": "Value"}\''
          );
        }
      }

      // Include iOS device info if specified
      if (flags.provider === 'ios' && flags.device) {
        navCmd.iosDevice = flags.device;
      }

      return navCmd;
    }

    case 'back':
      return { id, action: 'back' };

    case 'forward':
      return { id, action: 'forward' };

    case 'reload':
      return { id, action: 'reload' };

    // === Core Actions ===
    case 'click': {
      const newTab = rest.includes('--new-tab');
      const selector = rest.find((arg) => arg !== '--new-tab');

      if (!selector) {
        throw new MissingArgumentsError('click', 'click <selector> [--new-tab]');
      }

      return newTab
        ? { id, action: 'click', selector, newTab: true }
        : { id, action: 'click', selector };
    }

    case 'dblclick': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('dblclick', 'dblclick <selector>');
      }
      return { id, action: 'dblclick', selector: rest[0] };
    }

    case 'fill': {
      if (rest.length < 2) {
        throw new MissingArgumentsError('fill', 'fill <selector> <text>');
      }
      return { id, action: 'fill', selector: rest[0], value: rest.slice(1).join(' ') };
    }

    case 'setvalue': {
      if (rest.length < 2) {
        throw new MissingArgumentsError('setvalue', 'setvalue <selector> <value>');
      }
      return { id, action: 'fill', selector: rest[0], value: rest.slice(1).join(' ') };
    }

    case 'type': {
      if (rest.length < 2) {
        throw new MissingArgumentsError('type', 'type <selector> <text>');
      }
      return { id, action: 'type', selector: rest[0], text: rest.slice(1).join(' ') };
    }

    case 'hover': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('hover', 'hover <selector>');
      }
      return { id, action: 'hover', selector: rest[0] };
    }

    case 'focus': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('focus', 'focus <selector>');
      }
      return { id, action: 'focus', selector: rest[0] };
    }

    case 'check': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('check', 'check <selector>');
      }
      return { id, action: 'check', selector: rest[0] };
    }

    case 'uncheck': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('uncheck', 'uncheck <selector>');
      }
      return { id, action: 'uncheck', selector: rest[0] };
    }

    case 'select': {
      if (rest.length < 2) {
        throw new MissingArgumentsError('select', 'select <selector> <value...>');
      }
      const selector = rest[0];
      const values = rest.slice(1);
      return {
        id,
        action: 'select',
        selector,
        values: values.length === 1 ? values[0] : values,
      };
    }

    case 'drag': {
      if (rest.length < 2) {
        throw new MissingArgumentsError('drag', 'drag <source> <target>');
      }
      return { id, action: 'drag', source: rest[0], target: rest[1] };
    }

    case 'upload': {
      if (rest.length < 1) {
        throw new MissingArgumentsError('upload', 'upload <selector> <files...>');
      }
      return { id, action: 'upload', selector: rest[0], files: rest.slice(1) };
    }

    case 'download': {
      if (rest.length < 2) {
        throw new MissingArgumentsError('download', 'download <selector> <path>');
      }
      return { id, action: 'download', selector: rest[0], path: rest[1] };
    }

    // === Keyboard ===
    case 'press':
    case 'key': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('press', 'press <key>');
      }
      return { id, action: 'press', key: rest[0] };
    }

    case 'keydown': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('keydown', 'keydown <key>');
      }
      return { id, action: 'keydown', key: rest[0] };
    }

    case 'keyup': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('keyup', 'keyup <key>');
      }
      return { id, action: 'keyup', key: rest[0] };
    }

    case 'keyboard': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('keyboard', 'keyboard <type|inserttext> <text>');
      }
      const sub = rest[0];
      const text = rest.slice(1).join(' ');

      if (sub === 'type') {
        if (text.length === 0) {
          throw new MissingArgumentsError('keyboard type', 'keyboard type <text>');
        }
        return { id, action: 'keyboard', subaction: 'type', text };
      } else if (sub === 'inserttext' || sub === 'insertText') {
        if (text.length === 0) {
          throw new MissingArgumentsError('keyboard inserttext', 'keyboard inserttext <text>');
        }
        return { id, action: 'keyboard', subaction: 'insertText', text };
      } else {
        throw new UnknownSubcommandError(sub, ['type', 'inserttext']);
      }
    }

    case 'mouse': {
      const sub = rest[0];
      if (!sub) {
        throw new MissingArgumentsError('mouse', 'mouse <move|down|up|wheel> ...');
      }
      if (sub === 'move') {
        if (rest.length < 3) {
          throw new MissingArgumentsError('mouse move', 'mouse move <x> <y>');
        }
        return { id, action: 'mouse', event: 'move', x: Number(rest[1]), y: Number(rest[2]) };
      }
      if (sub === 'down') {
        return { id, action: 'mouse', event: 'down', button: rest[1] || 'left' };
      }
      if (sub === 'up') {
        return { id, action: 'mouse', event: 'up', button: rest[1] || 'left' };
      }
      if (sub === 'wheel') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('mouse wheel', 'mouse wheel <dy> [dx]');
        }
        return {
          id,
          action: 'mouse',
          event: 'wheel',
          dy: Number(rest[1]),
          dx: rest.length > 2 ? Number(rest[2]) : 0,
        };
      }
      throw new UnknownSubcommandError(sub, ['move', 'down', 'up', 'wheel']);
    }

    // === Scroll ===
    case 'scroll': {
      const result: Command = { id, action: 'scroll' };
      let positionalIndex = 0;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];

        if (arg === '-s' || arg === '--selector') {
          if (i + 1 < rest.length) {
            result.selector = rest[i + 1];
            i++;
          } else {
            throw new MissingArgumentsError('scroll --selector', 'scroll [direction] [amount] [--selector <sel>]');
          }
        } else if (!arg.startsWith('-')) {
          if (positionalIndex === 0) {
            result.direction = arg;
          } else if (positionalIndex === 1) {
            const amount = parseInt(arg, 10);
            if (!isNaN(amount)) {
              result.amount = amount;
            }
          }
          positionalIndex++;
        }
        i++;
      }

      result.direction = result.direction || 'down';
      result.amount = result.amount || 300;

      return result;
    }

    case 'scrollintoview':
    case 'scrollinto': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('scrollintoview', 'scrollintoview <selector>');
      }
      return { id, action: 'scrollintoview', selector: rest[0] };
    }

    // === Wait ===
    case 'wait': {
      const textIdx = rest.findIndex((arg) => arg === '--text');
      if (textIdx !== -1) {
        if (textIdx + 1 >= rest.length) {
          throw new MissingArgumentsError('wait --text', 'wait --text <text>');
        }
        return { id, action: 'wait', text: rest[textIdx + 1] };
      }

      const fnIdx = rest.findIndex((arg) => arg === '--fn');
      if (fnIdx !== -1) {
        if (fnIdx + 1 >= rest.length) {
          throw new MissingArgumentsError('wait --fn', 'wait --fn <expression>');
        }
        return { id, action: 'waitforfunction', expression: rest[fnIdx + 1] };
      }

      // Check for --url flag
      const urlIdx = rest.findIndex((arg) => arg === '--url' || arg === '-u');
      if (urlIdx !== -1) {
        if (urlIdx + 1 >= rest.length) {
          throw new MissingArgumentsError('wait --url', 'wait --url <pattern>');
        }
        return { id, action: 'waitforurl', url: rest[urlIdx + 1] };
      }

      // Check for --load flag
      const loadIdx = rest.findIndex((arg) => arg === '--load' || arg === '-l');
      if (loadIdx !== -1) {
        if (loadIdx + 1 >= rest.length) {
          throw new MissingArgumentsError('wait --load', 'wait --load <state>');
        }
        return { id, action: 'waitforloadstate', state: rest[loadIdx + 1] };
      }

      // Plain wait with optional selector or timeout
      if (rest.length === 0) {
        return { id, action: 'wait' };
      }

      const firstArg = rest[0];
      const timeout = parseInt(firstArg, 10);

      const stateIdx = rest.findIndex((arg) => arg === '--state');
      const selectorState = stateIdx !== -1 && stateIdx + 1 < rest.length ? rest[stateIdx + 1] : undefined;

      if (!isNaN(timeout)) {
        return { id, action: 'wait', timeout };
      } else {
        return selectorState
          ? { id, action: 'wait', selector: firstArg, state: selectorState }
          : { id, action: 'wait', selector: firstArg };
      }
    }

    case 'waitforselector': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('waitforselector', 'waitforselector <selector>');
      }
      return { id, action: 'wait', selector: rest[0] };
    }

    // === Snapshot & Screenshot ===
    case 'snapshot': {
      const interactive = rest.includes('--interactive') || rest.includes('-i');
      const compact = rest.includes('--compact') || rest.includes('-c');
      const includeUrls = rest.includes('--urls') || rest.includes('-u');
      const depthIdx = rest.findIndex((arg) => arg === '--depth' || arg === '-d');
      const maxDepthIdx = rest.findIndex((arg) => arg === '--max-depth');
      const selectorIdx = rest.findIndex((arg) => arg === '--selector' || arg === '-s');
      const cmd: Command = { id, action: 'snapshot' };
      if (interactive) cmd.interactive = true;
      if (compact) cmd.compact = true;
      if (includeUrls) cmd.urls = true;
      if (depthIdx !== -1 && depthIdx + 1 < rest.length) {
        cmd.maxDepth = parseInt(rest[depthIdx + 1], 10);
      } else if (maxDepthIdx !== -1 && maxDepthIdx + 1 < rest.length) {
        // Backward compatibility with previous claw-browser option name
        cmd.maxDepth = parseInt(rest[maxDepthIdx + 1], 10);
      }
      if (selectorIdx !== -1 && selectorIdx + 1 < rest.length) {
        cmd.selector = rest[selectorIdx + 1];
      }
      return cmd;
    }

    case 'screenshot': {
      const result: Command = { id, action: 'screenshot' };

      if (rest.includes('--full-page') || rest.includes('-f')) {
        result.fullPage = true;
      }
      if (rest.includes('--full')) {
        result.fullPage = true;
      }

      if (flags.cliAnnotate) {
        result.annotate = true;
      }
      if (rest.includes('--annotate')) {
        result.annotate = true;
      }

      const dirIdx = rest.findIndex((arg) => arg === '--screenshot-dir');
      if (dirIdx !== -1 && dirIdx + 1 < rest.length) {
        result.screenshotDir = rest[dirIdx + 1];
      }
      const formatIdx = rest.findIndex((arg) => arg === '--screenshot-format');
      if (formatIdx !== -1 && formatIdx + 1 < rest.length) {
        result.format = rest[formatIdx + 1];
      }
      const qualityIdx = rest.findIndex((arg) => arg === '--screenshot-quality');
      if (qualityIdx !== -1 && qualityIdx + 1 < rest.length) {
        result.quality = parseInt(rest[qualityIdx + 1], 10);
      }

      const selector = rest.find((arg, idx) => {
        if (arg.startsWith('-')) return false;
        const prev = idx > 0 ? rest[idx - 1] : '';
        if (prev === '--screenshot-dir' || prev === '--screenshot-format' || prev === '--screenshot-quality') {
          return false;
        }
        return true;
      });
      if (selector) {
        if (selector.endsWith('.png') || selector.endsWith('.jpg') || selector.endsWith('.jpeg') || selector.endsWith('.webp')) {
          result.path = selector;
        } else {
          result.selector = selector;
        }
      }

      return result;
    }

    case 'pdf': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('pdf', 'pdf <path>');
      }
      return { id, action: 'pdf', path: rest[0] };
    }

    // === Cookies ===
    case 'cookies': {
      const sub = rest[0];

      if (sub === 'get' || !sub) {
        return { id, action: 'cookies_get' };
      } else if (sub === 'set') {
        if (rest.length < 3) {
          throw new MissingArgumentsError('cookies set', 'cookies set <name> <value>');
        }
        return { id, action: 'cookies_set', name: rest[1], value: rest[2] };
      } else if (sub === 'clear') {
        return { id, action: 'cookies_clear' };
      } else {
        throw new UnknownSubcommandError(sub, ['get', 'set', 'clear']);
      }
    }

    // === Storage ===
    case 'storage': {
      const sub = rest[0];

      if (!sub) {
        throw new MissingArgumentsError('storage', 'storage <local|session> [key|set|clear] ...');
      }

      if (sub === 'get' || sub === 'set' || sub === 'clear') {
        if (sub === 'get') {
          if (rest.length < 2) {
            throw new MissingArgumentsError('storage get', 'storage get <local|session> [key]');
          }
          const type = rest[1] === 'local' ? 'local' : 'session';
          const key = rest[2];
          return key ? { id, action: 'storage_get', type, key } : { id, action: 'storage_get', type };
        } else if (sub === 'set') {
          if (rest.length < 4) {
            throw new MissingArgumentsError('storage set', 'storage set <local|session> <key> <value>');
          }
          const type = rest[1] === 'local' ? 'local' : 'session';
          return { id, action: 'storage_set', type, key: rest[2], value: rest.slice(3).join(' ') };
        } else {
          if (rest.length < 2) {
            throw new MissingArgumentsError('storage clear', 'storage clear <local|session>');
          }
          const type = rest[1] === 'local' ? 'local' : 'session';
          return { id, action: 'storage_clear', type };
        }
      }

      if (sub === 'local' || sub === 'session') {
        const type = sub;
        const next = rest[1];
        if (!next) {
          return { id, action: 'storage_get', type };
        }
        if (next === 'set') {
          if (rest.length < 4) {
            throw new MissingArgumentsError(`storage ${type} set`, `storage ${type} set <key> <value>`);
          }
          return { id, action: 'storage_set', type, key: rest[2], value: rest.slice(3).join(' ') };
        }
        if (next === 'clear') {
          return { id, action: 'storage_clear', type };
        }
        return { id, action: 'storage_get', type, key: next };
      }

      throw new UnknownSubcommandError(sub, ['local', 'session', 'get', 'set', 'clear']);
    }

    // === Network ===
    case 'route': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('route', 'route <pattern> [response]');
      }
      return { id, action: 'route', pattern: rest[0] };
    }

    case 'unroute': {
      return rest[0] ? { id, action: 'unroute', pattern: rest[0] } : { id, action: 'unroute' };
    }

    case 'network': {
      const sub = rest[0];
      if (!sub) {
        throw new MissingArgumentsError('network', 'network <route|unroute|requests|request|har> ...');
      }
      if (sub === 'route') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('network route', 'network route <url> [--abort|--body <json>]');
        }
        const cmd: Command = { id, action: 'route', pattern: rest[1] };
        const abort = rest.includes('--abort');
        if (abort) {
          cmd.abort = true;
        }
        const bodyIdx = rest.findIndex((arg) => arg === '--body');
        if (bodyIdx !== -1 && bodyIdx + 1 < rest.length) {
          cmd.body = rest[bodyIdx + 1];
        }
        return cmd;
      }
      if (sub === 'unroute') {
        return rest[1] ? { id, action: 'unroute', pattern: rest[1] } : { id, action: 'unroute' };
      }
      if (sub === 'requests') {
        const cmd: Command = { id, action: 'network_requests' };
        const filterIdx = rest.findIndex((arg) => arg === '--filter');
        if (filterIdx !== -1 && filterIdx + 1 < rest.length) cmd.filter = rest[filterIdx + 1];
        const typeIdx = rest.findIndex((arg) => arg === '--type');
        if (typeIdx !== -1 && typeIdx + 1 < rest.length) cmd.resourceType = rest[typeIdx + 1];
        const methodIdx = rest.findIndex((arg) => arg === '--method');
        if (methodIdx !== -1 && methodIdx + 1 < rest.length) cmd.method = rest[methodIdx + 1];
        const statusIdx = rest.findIndex((arg) => arg === '--status');
        if (statusIdx !== -1 && statusIdx + 1 < rest.length) cmd.status = rest[statusIdx + 1];
        return cmd;
      }
      if (sub === 'request') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('network request', 'network request <requestId>');
        }
        return { id, action: 'network_request', requestId: rest[1] };
      }
      if (sub === 'har') {
        if (rest[1] === 'start') return { id, action: 'har_start' };
        if (rest[1] === 'stop') return rest[2] ? { id, action: 'har_stop', path: rest[2] } : { id, action: 'har_stop' };
      }
      throw new UnknownSubcommandError(sub, ['route', 'unroute', 'requests', 'request', 'har']);
    }

    // === State ===
    case 'state': {
      const sub = rest[0];
      if (!sub) {
        throw new MissingArgumentsError('state', 'state <save|load|list|show|rename|clear|clean> ...');
      }
      if (sub === 'save') {
        return rest[1] ? { id, action: 'state_save', path: rest[1] } : { id, action: 'state_save' };
      }
      if (sub === 'load') {
        if (!rest[1]) {
          throw new MissingArgumentsError('state load', 'state load <path>');
        }
        return { id, action: 'state_load', path: rest[1] };
      }
      if (sub === 'list') return { id, action: 'state_list' };
      if (sub === 'show') {
        if (!rest[1]) throw new MissingArgumentsError('state show', 'state show <file>');
        return { id, action: 'state_show', file: rest[1] };
      }
      if (sub === 'rename') {
        if (rest.length < 3) throw new MissingArgumentsError('state rename', 'state rename <old> <new>');
        return { id, action: 'state_rename', old: rest[1], new: rest[2] };
      }
      if (sub === 'clear') {
        if (rest.includes('--all')) return { id, action: 'state_clear', all: true };
        return rest[1] ? { id, action: 'state_clear', name: rest[1] } : { id, action: 'state_clear' };
      }
      if (sub === 'clean') {
        const idx = rest.findIndex((arg) => arg === '--older-than');
        if (idx === -1 || idx + 1 >= rest.length) {
          throw new MissingArgumentsError('state clean', 'state clean --older-than <days>');
        }
        return { id, action: 'state_clean', olderThanDays: parseInt(rest[idx + 1], 10) };
      }
      throw new UnknownSubcommandError(sub, ['save', 'load', 'list', 'show', 'rename', 'clear', 'clean']);
    }

    // === JavaScript evaluation ===
    case 'evaluate':
    case 'eval': {
      if (rest.length === 0) {
        throw new MissingArgumentsError(cmd, `${cmd} <script>`);
      }
      const stdin = rest.includes('--stdin');
      const bIdx = rest.findIndex((arg) => arg === '-b');
      if (stdin) {
        return { id, action: 'evaluate', stdin: true };
      }
      if (bIdx !== -1 && bIdx + 1 < rest.length) {
        return { id, action: 'evaluate', scriptBase64: rest[bIdx + 1], base64: true };
      }
      return { id, action: 'evaluate', script: rest.filter((arg) => arg !== '--stdin').join(' ') };
    }

    case 'get': {
      const sub = rest[0];
      if (!sub) {
        throw new MissingArgumentsError('get', 'get <text|html|value|attr|title|url|cdp-url|count|box|styles> ...');
      }
      if (sub === 'text') {
        if (!rest[1]) throw new MissingArgumentsError('get text', 'get text <selector>');
        return { id, action: 'gettext', selector: rest[1] };
      }
      if (sub === 'html') {
        if (!rest[1]) throw new MissingArgumentsError('get html', 'get html <selector>');
        return { id, action: 'innerhtml', selector: rest[1] };
      }
      if (sub === 'value') {
        if (!rest[1]) throw new MissingArgumentsError('get value', 'get value <selector>');
        return { id, action: 'inputvalue', selector: rest[1] };
      }
      if (sub === 'attr') {
        if (rest.length < 3) throw new MissingArgumentsError('get attr', 'get attr <selector> <attr>');
        return { id, action: 'getattribute', selector: rest[1], attribute: rest[2] };
      }
      if (sub === 'title') return { id, action: 'title' };
      if (sub === 'url') return { id, action: 'url' };
      if (sub === 'cdp-url') return { id, action: 'cdp_url' };
      if (sub === 'count') {
        if (!rest[1]) throw new MissingArgumentsError('get count', 'get count <selector>');
        return { id, action: 'count', selector: rest[1] };
      }
      if (sub === 'box') {
        if (!rest[1]) throw new MissingArgumentsError('get box', 'get box <selector>');
        return { id, action: 'boundingbox', selector: rest[1] };
      }
      if (sub === 'styles') {
        if (!rest[1]) throw new MissingArgumentsError('get styles', 'get styles <selector>');
        return { id, action: 'styles', selector: rest[1] };
      }
      throw new UnknownSubcommandError(sub, ['text', 'html', 'value', 'attr', 'title', 'url', 'cdp-url', 'count', 'box', 'styles']);
    }

    case 'is': {
      const sub = rest[0];
      if (!sub || !rest[1]) {
        throw new MissingArgumentsError('is', 'is <visible|enabled|checked> <selector>');
      }
      if (sub === 'visible') return { id, action: 'isvisible', selector: rest[1] };
      if (sub === 'enabled') return { id, action: 'isenabled', selector: rest[1] };
      if (sub === 'checked') return { id, action: 'ischecked', selector: rest[1] };
      throw new UnknownSubcommandError(sub, ['visible', 'enabled', 'checked']);
    }

    case 'set': {
      const sub = rest[0];
      if (!sub) {
        throw new MissingArgumentsError('set', 'set <viewport|offline|headers|media|credentials> ...');
      }
      if (sub === 'viewport') {
        if (rest.length < 3) throw new MissingArgumentsError('set viewport', 'set viewport <width> <height> [scale]');
        const cmd: Command = { id, action: 'viewport', width: parseInt(rest[1], 10), height: parseInt(rest[2], 10) };
        if (rest[3]) cmd.deviceScaleFactor = parseFloat(rest[3]);
        return cmd;
      }
      if (sub === 'offline') {
        const mode = rest[1] || 'on';
        return { id, action: 'offline', offline: mode !== 'off' };
      }
      if (sub === 'headers') {
        if (!rest[1]) throw new MissingArgumentsError('set headers', 'set headers <json>');
        return { id, action: 'headers', headers: rest.slice(1).join(' ') };
      }
      if (sub === 'media') {
        return { id, action: 'set_media', colorScheme: rest[1] || 'light' };
      }
      if (sub === 'credentials') {
        if (rest.length < 3) throw new MissingArgumentsError('set credentials', 'set credentials <username> <password>');
        return { id, action: 'credentials_set', username: rest[1], password: rest[2] };
      }
      if (sub === 'device') {
        if (!rest[1]) throw new MissingArgumentsError('set device', 'set device <name>');
        return { id, action: 'device', name: rest.slice(1).join(' ') };
      }
      if (sub === 'geo') {
        if (rest.length < 3) throw new MissingArgumentsError('set geo', 'set geo <lat> <lng>');
        return { id, action: 'geolocation', latitude: parseFloat(rest[1]), longitude: parseFloat(rest[2]) };
      }
      if (sub === 'timezone') {
        if (!rest[1]) throw new MissingArgumentsError('set timezone', 'set timezone <timezoneId>');
        return { id, action: 'timezone', timezoneId: rest[1] };
      }
      if (sub === 'locale') {
        if (!rest[1]) throw new MissingArgumentsError('set locale', 'set locale <locale>');
        return { id, action: 'locale', locale: rest[1] };
      }
      if (sub === 'permissions') {
        if (rest.length < 2) throw new MissingArgumentsError('set permissions', 'set permissions <permission...>');
        return { id, action: 'permissions', permissions: rest.slice(1) };
      }
      if (sub === 'content') {
        if (rest.length < 2) throw new MissingArgumentsError('set content', 'set content <html>');
        return { id, action: 'setcontent', html: rest.slice(1).join(' ') };
      }
      if (sub === 'useragent' || sub === 'user-agent') {
        if (rest.length < 2) throw new MissingArgumentsError('set useragent', 'set useragent <ua>');
        return { id, action: 'useragent', userAgent: rest.slice(1).join(' ') };
      }
      throw new UnknownSubcommandError(sub, ['viewport', 'offline', 'headers', 'media', 'credentials', 'device', 'geo', 'timezone', 'locale', 'permissions', 'content', 'useragent']);
    }

    // === Tabs ===
    case 'tab':
    case 'tabs': {
      const sub = rest[0];

      if (!sub || sub === 'list') {
        return { id, action: 'tab_list' };
      } else if (sub === 'new') {
        let label: string | undefined;
        let url: string | undefined;

        for (let i = 1; i < rest.length; i++) {
          const arg = rest[i];
          if (arg === '--label') {
            const next = rest[i + 1];
            if (!next) {
              throw new MissingArgumentsError('tab new --label', 'tab new --label <name> [url]');
            }
            label = next;
            i++;
            continue;
          }
          if (!url) {
            url = arg;
          }
        }

        const cmd: Command = { id, action: 'tab_new' };
        if (label) {
          cmd.label = label;
        }
        if (url) {
          cmd.url = normalizeUrlLikeOpen(url);
        }
        return cmd;
      } else if (sub === 'close') {
        const target = rest[1];
        if (!target) {
          return { id, action: 'tab_close' };
        }
        return { id, action: 'tab_close', ...parseTabSelector(target) };
      } else if (sub === 'switch') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('tab switch', 'tab switch <target>');
        }
        const target = rest[1];
        return { id, action: 'tab_switch', ...parseTabSelector(target) };
      } else {
        if (sub === '--help' || sub === '-h') {
          throw new MissingArgumentsError('tab', 'tab [list|new|close|switch|<target>]');
        }
        return { id, action: 'tab_switch', ...parseTabSelector(sub) };
      }
    }

    case 'window': {
      const sub = rest[0];
      if (sub !== 'new') {
        throw new UnknownSubcommandError(sub || '', ['new']);
      }
      const cmd: Command = { id, action: 'window_new' };
      let i = 1;
      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '--label') {
          const next = rest[i + 1];
          if (!next) {
            throw new MissingArgumentsError('window new --label', 'window new --label <name> [url]');
          }
          cmd.label = next;
          i += 2;
          continue;
        }
        if (!cmd.url && !arg.startsWith('-')) {
          cmd.url = normalizeUrlLikeOpen(arg);
        }
        i++;
      }
      return cmd;
    }

    case 'frame': {
      if (!rest[0]) {
        throw new MissingArgumentsError('frame', 'frame <selector|main>');
      }
      if (rest[0] === 'main') {
        return { id, action: 'mainframe' };
      }
      return { id, action: 'frame', selector: rest[0] };
    }

    case 'dialog': {
      const sub = rest[0];
      if (!sub) {
        throw new MissingArgumentsError('dialog', 'dialog <accept|dismiss|status> [text]');
      }
      if (sub === 'accept') return { id, action: 'dialog', op: 'accept', text: rest.slice(1).join(' ') || undefined };
      if (sub === 'dismiss') return { id, action: 'dialog', op: 'dismiss' };
      if (sub === 'status') return { id, action: 'dialog', op: 'status' };
      throw new UnknownSubcommandError(sub, ['accept', 'dismiss', 'status']);
    }

    case 'console': {
      return { id, action: 'console', clear: rest.includes('--clear') };
    }

    case 'errors': {
      return { id, action: 'errors', clear: rest.includes('--clear') };
    }

    case 'inspect':
      return { id, action: 'inspect' };

    case 'highlight': {
      if (!rest[0]) {
        throw new MissingArgumentsError('highlight', 'highlight <selector>');
      }
      return { id, action: 'highlight', selector: rest[0] };
    }

    case 'selectall':
      return { id, action: 'selectall' };

    case 'clipboard': {
      const op = rest[0];
      if (!op) throw new MissingArgumentsError('clipboard', 'clipboard <read|write> [text]');
      if (op === 'read') return { id, action: 'clipboard', op: 'read' };
      if (op === 'write') return { id, action: 'clipboard', op: 'write', text: rest.slice(1).join(' ') };
      throw new UnknownSubcommandError(op, ['read', 'write']);
    }

    case 'responsebody': {
      if (!rest[0]) {
        throw new MissingArgumentsError('responsebody', 'responsebody <requestId>');
      }
      return { id, action: 'responsebody', requestId: rest[0] };
    }

    case 'bringtofront':
      return { id, action: 'bringtofront' };

    case 'find': {
      if (rest.length < 3) {
        throw new MissingArgumentsError('find', 'find <kind> <query> <action> [value]');
      }
      return {
        id,
        action: 'find',
        kind: rest[0],
        query: rest[1],
        findAction: rest[2],
        value: rest.length > 3 ? rest.slice(3).join(' ') : undefined,
      };
    }

    case 'stream': {
      const sub = rest[0];
      if (!sub) throw new MissingArgumentsError('stream', 'stream <enable|disable|status> ...');
      if (sub === 'enable') {
        const portIdx = rest.findIndex((arg) => arg === '--port');
        const port = portIdx !== -1 && portIdx + 1 < rest.length ? parseInt(rest[portIdx + 1], 10) : undefined;
        return { id, action: 'stream_enable', port };
      }
      if (sub === 'disable') return { id, action: 'stream_disable' };
      if (sub === 'status') return { id, action: 'stream_status' };
      throw new UnknownSubcommandError(sub, ['enable', 'disable', 'status']);
    }

    case 'install':
      return { id, action: 'install' };
    case 'upgrade':
      return { id, action: 'upgrade' };
    case 'chat':
      return { id, action: 'chat', prompt: rest.join(' ') || undefined };

    // === Unknown ===
    default:
      throw new UnknownCommandError(cmd);
  }
}
