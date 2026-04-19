// Command types for claw-browser CLI
export interface Command {
  id: string;
  action: string;
  [key: string]: unknown;
}

// Navigation commands
export interface NavigateCommand extends Command {
  action: 'navigate';
  url: string;
  waitUntil?: 'none' | 'load' | 'domcontentloaded' | 'networkidle';
  headers?: Record<string, string>;
  iosDevice?: string;
}

export interface BackCommand extends Command {
  action: 'back';
}

export interface ForwardCommand extends Command {
  action: 'forward';
}

export interface ReloadCommand extends Command {
  action: 'reload';
}

// Interaction commands
export interface ClickCommand extends Command {
  action: 'click';
  selector: string;
  newTab?: boolean;
}

export interface DblClickCommand extends Command {
  action: 'dblclick';
  selector: string;
}

export interface FillCommand extends Command {
  action: 'fill';
  selector: string;
  value: string;
}

export interface TypeCommand extends Command {
  action: 'type';
  selector: string;
  text: string;
}

export interface HoverCommand extends Command {
  action: 'hover';
  selector: string;
}

// Snapshot and screenshot commands
export interface SnapshotCommand extends Command {
  action: 'snapshot';
  markdown?: boolean;
}

export interface ScreenshotCommand extends Command {
  action: 'screenshot';
  selector?: string;
  fullPage?: boolean;
  annotate?: boolean;
}

// Wait commands
export interface WaitCommand extends Command {
  action: 'wait' | 'waitForSelector' | 'waitForNavigation';
  selector?: string;
  timeout?: number;
}

// Cookie commands
export interface SetCookieCommand extends Command {
  action: 'setCookie';
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface GetCookiesCommand extends Command {
  action: 'getCookies';
}

export interface ClearCookiesCommand extends Command {
  action: 'clearCookies';
}

// Storage commands
export interface SetStorageCommand extends Command {
  action: 'setStorage';
  type: 'localStorage' | 'sessionStorage';
  key: string;
  value: string;
}

export interface GetStorageCommand extends Command {
  action: 'getStorage';
  type: 'localStorage' | 'sessionStorage';
  key?: string;
}

export interface ClearStorageCommand extends Command {
  action: 'clearStorage';
  type: 'localStorage' | 'sessionStorage';
}

// Network commands
export interface RouteCommand extends Command {
  action: 'route';
  pattern: string;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  };
}

// State commands
export interface SaveStateCommand extends Command {
  action: 'saveState';
  path?: string;
}

export interface LoadStateCommand extends Command {
  action: 'loadState';
  path?: string;
}

// Tab commands
export interface NewTabCommand extends Command {
  action: 'newTab';
  url?: string;
}

export interface CloseTabCommand extends Command {
  action: 'closeTab';
  index?: number;
}

export interface SwitchTabCommand extends Command {
  action: 'switchTab';
  index: number;
}

export interface ListTabsCommand extends Command {
  action: 'listTabs';
}

// Command union type
export type AnyCommand =
  | NavigateCommand
  | BackCommand
  | ForwardCommand
  | ReloadCommand
  | ClickCommand
  | DblClickCommand
  | FillCommand
  | TypeCommand
  | HoverCommand
  | SnapshotCommand
  | ScreenshotCommand
  | WaitCommand
  | SetCookieCommand
  | GetCookiesCommand
  | ClearCookiesCommand
  | SetStorageCommand
  | GetStorageCommand
  | ClearStorageCommand
  | RouteCommand
  | SaveStateCommand
  | LoadStateCommand
  | NewTabCommand
  | CloseTabCommand
  | SwitchTabCommand
  | ListTabsCommand;

// Parse error types
export class ParseError extends Error {
  constructor(
    message: string,
    public context?: string,
    public usage?: string
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

export class UnknownCommandError extends ParseError {
  constructor(command: string) {
    super(`Unknown command: ${command}`);
    this.name = 'UnknownCommandError';
  }
}

export class UnknownSubcommandError extends ParseError {
  constructor(subcommand: string, validOptions: string[]) {
    super(
      `Unknown subcommand: ${subcommand}\nValid options: ${validOptions.join(', ')}`
    );
    this.name = 'UnknownSubcommandError';
  }
}

export class MissingArgumentsError extends ParseError {
  constructor(context: string, usage: string) {
    super(
      `Missing arguments for: ${context}\nUsage: claw-browser ${usage}`,
      context,
      usage
    );
    this.name = 'MissingArgumentsError';
  }
}

export class InvalidValueError extends ParseError {
  constructor(message: string, usage: string) {
    super(`${message}\nUsage: claw-browser ${usage}`, undefined, usage);
    this.name = 'InvalidValueError';
  }
}

export class InvalidSessionNameError extends ParseError {
  constructor(name: string) {
    super(
      `Invalid session name: ${name}\nSession names must not contain path separators or invalid characters`
    );
    this.name = 'InvalidSessionNameError';
  }
}

// CLI flags
export interface Flags {
  provider?: string;
  device?: string;
  headers?: string;
  defaultTimeout?: number;
  cliAnnotate?: boolean;
  headed?: boolean;
  cdp?: string;
  tabId?: string;
  json?: boolean;
  session?: string;
  profile?: string;
}
