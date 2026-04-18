import type { Command, Flags } from '../types/commands.js';
import {
  MissingArgumentsError,
  UnknownCommandError,
  UnknownSubcommandError,
  InvalidValueError,
  InvalidSessionNameError,
} from '../types/commands.js';

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

  // Inject default timeout into wait-family commands if not already present
  if (result.action.startsWith('wait') && !result.timeout && flags.defaultTimeout) {
    result.timeout = flags.defaultTimeout;
  }

  return result;
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
      let url = rest[0];
      const urlLower = url.toLowerCase();

      // Add https:// if no protocol specified
      if (
        !urlLower.startsWith('http://') &&
        !urlLower.startsWith('https://') &&
        !urlLower.startsWith('about:') &&
        !urlLower.startsWith('data:') &&
        !urlLower.startsWith('file:') &&
        !urlLower.startsWith('chrome-extension://') &&
        !urlLower.startsWith('chrome://')
      ) {
        url = `https://${url}`;
      }

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

      if (!isNaN(timeout)) {
        return { id, action: 'wait', timeout };
      } else {
        return { id, action: 'waitforselector', selector: firstArg };
      }
    }

    case 'waitforselector': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('waitforselector', 'waitforselector <selector>');
      }
      return { id, action: 'waitforselector', selector: rest[0] };
    }

    // === Snapshot & Screenshot ===
    case 'snapshot': {
      const markdown = rest.includes('--markdown') || rest.includes('-m');
      return markdown ? { id, action: 'snapshot', markdown: true } : { id, action: 'snapshot' };
    }

    case 'screenshot': {
      const result: Command = { id, action: 'screenshot' };

      if (rest.includes('--full-page') || rest.includes('-f')) {
        result.fullPage = true;
      }

      if (flags.cliAnnotate) {
        result.annotate = true;
      }

      const selector = rest.find((arg) => !arg.startsWith('-'));
      if (selector) {
        result.selector = selector;
      }

      return result;
    }

    // === Cookies ===
    case 'cookies': {
      const sub = rest[0];

      if (sub === 'get' || !sub) {
        return { id, action: 'getCookies' };
      } else if (sub === 'set') {
        if (rest.length < 3) {
          throw new MissingArgumentsError('cookies set', 'cookies set <name> <value>');
        }
        return { id, action: 'setCookie', name: rest[1], value: rest[2] };
      } else if (sub === 'clear') {
        return { id, action: 'clearCookies' };
      } else {
        throw new UnknownSubcommandError(sub, ['get', 'set', 'clear']);
      }
    }

    // === Storage ===
    case 'storage': {
      const sub = rest[0];

      if (!sub) {
        throw new MissingArgumentsError('storage', 'storage <get|set|clear> [args...]');
      }

      if (sub === 'get') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('storage get', 'storage get <local|session> [key]');
        }
        const type = rest[1] === 'local' ? 'localStorage' : 'sessionStorage';
        const key = rest[2];
        return key ? { id, action: 'getStorage', type, key } : { id, action: 'getStorage', type };
      } else if (sub === 'set') {
        if (rest.length < 4) {
          throw new MissingArgumentsError('storage set', 'storage set <local|session> <key> <value>');
        }
        const type = rest[1] === 'local' ? 'localStorage' : 'sessionStorage';
        return { id, action: 'setStorage', type, key: rest[2], value: rest[3] };
      } else if (sub === 'clear') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('storage clear', 'storage clear <local|session>');
        }
        const type = rest[1] === 'local' ? 'localStorage' : 'sessionStorage';
        return { id, action: 'clearStorage', type };
      } else {
        throw new UnknownSubcommandError(sub, ['get', 'set', 'clear']);
      }
    }

    // === Network ===
    case 'route': {
      if (rest.length === 0) {
        throw new MissingArgumentsError('route', 'route <pattern> [response]');
      }
      return { id, action: 'route', pattern: rest[0] };
    }

    // === State ===
    case 'save': {
      return rest.length > 0
        ? { id, action: 'saveState', path: rest[0] }
        : { id, action: 'saveState' };
    }

    case 'load': {
      return rest.length > 0
        ? { id, action: 'loadState', path: rest[0] }
        : { id, action: 'loadState' };
    }

    // === Tabs ===
    case 'tabs': {
      const sub = rest[0];

      if (!sub || sub === 'list') {
        return { id, action: 'listTabs' };
      } else if (sub === 'new') {
        const url = rest[1];
        return url ? { id, action: 'newTab', url } : { id, action: 'newTab' };
      } else if (sub === 'close') {
        const index = rest[1] ? parseInt(rest[1], 10) : undefined;
        return { id, action: 'closeTab', index };
      } else if (sub === 'switch') {
        if (rest.length < 2) {
          throw new MissingArgumentsError('tabs switch', 'tabs switch <index>');
        }
        const index = parseInt(rest[1], 10);
        if (isNaN(index)) {
          throw new InvalidValueError('Tab index must be a number', 'tabs switch <index>');
        }
        return { id, action: 'switchTab', index };
      } else {
        throw new UnknownSubcommandError(sub, ['list', 'new', 'close', 'switch']);
      }
    }

    // === Unknown ===
    default:
      throw new UnknownCommandError(cmd);
  }
}
