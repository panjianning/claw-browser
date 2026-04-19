import type { Flags } from '../types/commands.js';

export interface HelpTopic {
  usage: string;
  description?: string;
  subcommands?: Record<string, HelpTopic>;
}

export interface HelpOverviewItem {
  command: string;
  summary: string;
}

export interface HelpOverviewSection {
  title: string;
  items: HelpOverviewItem[];
}

export interface GlobalFlagDef {
  names: string[];
  field: keyof Flags;
  kind: 'string' | 'number' | 'boolean';
  description: string;
}

export const GLOBAL_FLAG_DEFS: GlobalFlagDef[] = [
  { names: ['--session'], field: 'session', kind: 'string', description: 'Select session.' },
  { names: ['--profile'], field: 'profile', kind: 'string', description: 'Browser profile path/name.' },
  { names: ['--tab-id', '--tabid'], field: 'tabId', kind: 'string', description: 'Route command to a specific tab.' },
  { names: ['--cdp'], field: 'cdp', kind: 'string', description: 'Connect daemon commands to a CDP endpoint.' },
  { names: ['--provider'], field: 'provider', kind: 'string', description: 'Provider selector.' },
  { names: ['--device'], field: 'device', kind: 'string', description: 'Device selector.' },
  { names: ['--headers'], field: 'headers', kind: 'string', description: 'Default headers for navigation (JSON).' },
  { names: ['--default-timeout'], field: 'defaultTimeout', kind: 'number', description: 'Default timeout for wait-family commands (ms).' },
  { names: ['--headed'], field: 'headed', kind: 'boolean', description: 'Launch in headed mode.' },
  { names: ['--annotate'], field: 'cliAnnotate', kind: 'boolean', description: 'Enable screenshot annotation mode.' },
  { names: ['--json', '-j'], field: 'json', kind: 'boolean', description: 'Emit JSON output.' },
];

export const HELP_CATALOG: Record<string, HelpTopic> = {
  open: { usage: 'claw-browser [global options] open <url>', description: 'Open a URL in the active tab.' },
  goto: { usage: 'claw-browser [global options] goto <url>', description: 'Alias of open.' },
  navigate: { usage: 'claw-browser [global options] navigate <url>', description: 'Alias of open.' },
  back: { usage: 'claw-browser [global options] back', description: 'Navigate back in history.' },
  forward: { usage: 'claw-browser [global options] forward', description: 'Navigate forward in history.' },
  reload: { usage: 'claw-browser [global options] reload', description: 'Reload current page.' },
  click: { usage: 'claw-browser [global options] click <selector> [--new-tab]' },
  dblclick: { usage: 'claw-browser [global options] dblclick <selector>' },
  fill: { usage: 'claw-browser [global options] fill <selector> <text>' },
  setvalue: { usage: 'claw-browser [global options] setvalue <selector> <value>' },
  type: { usage: 'claw-browser [global options] type <selector> <text>' },
  hover: { usage: 'claw-browser [global options] hover <selector>' },
  focus: { usage: 'claw-browser [global options] focus <selector>' },
  check: { usage: 'claw-browser [global options] check <selector>' },
  uncheck: { usage: 'claw-browser [global options] uncheck <selector>' },
  select: { usage: 'claw-browser [global options] select <selector> <value...>' },
  drag: { usage: 'claw-browser [global options] drag <source> <target>' },
  upload: { usage: 'claw-browser [global options] upload <selector> <files...>' },
  download: { usage: 'claw-browser [global options] download <selector> <path>' },
  press: { usage: 'claw-browser [global options] press <key>', description: 'Press a key (for example: Enter, Escape, ArrowDown, Ctrl+K).' },
  key: { usage: 'claw-browser [global options] press <key>', description: 'Alias of press.' },
  keydown: { usage: 'claw-browser [global options] keydown <key>', description: 'Send keyDown only.' },
  keyup: { usage: 'claw-browser [global options] keyup <key>', description: 'Send keyUp only.' },
  keyboard: {
    usage: 'claw-browser [global options] keyboard <type|inserttext> <text>',
    subcommands: {
      type: { usage: 'claw-browser [global options] keyboard type <text>' },
      inserttext: { usage: 'claw-browser [global options] keyboard inserttext <text>' },
    },
  },
  mouse: {
    usage: 'claw-browser [global options] mouse <move|down|up|wheel> ...',
    subcommands: {
      move: { usage: 'claw-browser [global options] mouse move <x> <y>' },
      down: { usage: 'claw-browser [global options] mouse down [button]' },
      up: { usage: 'claw-browser [global options] mouse up [button]' },
      wheel: { usage: 'claw-browser [global options] mouse wheel <dy> [dx]' },
    },
  },
  scroll: { usage: 'claw-browser [global options] scroll [direction] [amount] [--selector <selector>]' },
  scrollintoview: { usage: 'claw-browser [global options] scrollintoview <selector>' },
  scrollinto: { usage: 'claw-browser [global options] scrollinto <selector>', description: 'Alias of scrollintoview.' },
  wait: { usage: 'claw-browser [global options] wait [<ms>|<selector>] [--state <visible|hidden|attached|detached>] [--text <text>] [--url <pattern>] [--fn <expression>] [--load <state>]' },
  waitforurl: { usage: 'claw-browser [global options] waitforurl <pattern>' },
  waitforloadstate: { usage: 'claw-browser [global options] waitforloadstate <load|domcontentloaded|networkidle>' },
  waitforselector: { usage: 'claw-browser [global options] waitforselector <selector>' },
  waitforfunction: { usage: 'claw-browser [global options] waitforfunction <expression>' },
  snapshot: { usage: 'claw-browser [global options] snapshot [--interactive|-i] [--compact|-c] [--urls|-u] [--depth|-d <n>] [--selector|-s <selector>]' },
  screenshot: { usage: 'claw-browser [global options] screenshot [selector|path] [--full-page|-f] [--annotate]' },
  pdf: { usage: 'claw-browser [global options] pdf <path>' },
  cookies: { usage: 'claw-browser [global options] cookies <get|set|clear> ...' },
  storage: {
    usage: 'claw-browser [global options] storage <local|session|get|set|clear> ...',
    subcommands: {
      get: { usage: 'claw-browser [global options] storage get <local|session> [key]' },
      set: { usage: 'claw-browser [global options] storage set <local|session> <key> <value>' },
      clear: { usage: 'claw-browser [global options] storage clear <local|session>' },
      local: { usage: 'claw-browser [global options] storage local [key|set|clear ...]' },
      session: { usage: 'claw-browser [global options] storage session [key|set|clear ...]' },
    },
  },
  network: {
    usage: 'claw-browser [global options] network <route|unroute|requests|request|har> ...',
    subcommands: {
      route: { usage: 'claw-browser [global options] network route <url> [--abort|--body <json>]' },
      unroute: { usage: 'claw-browser [global options] network unroute [url]' },
      requests: { usage: 'claw-browser [global options] network requests [--filter <text>] [--type <resourceType>] [--method <method>] [--status <status>]' },
      request: { usage: 'claw-browser [global options] network request <requestId>' },
      har: { usage: 'claw-browser [global options] network har <start|stop> [path]' },
    },
  },
  set: {
    usage: 'claw-browser [global options] set <viewport|offline|headers|media|credentials|device|geo|timezone|locale|permissions|content|useragent> ...',
    subcommands: {
      viewport: { usage: 'claw-browser [global options] set viewport <width> <height> [scale]' },
      offline: { usage: 'claw-browser [global options] set offline <on|off>' },
      headers: { usage: 'claw-browser [global options] set headers <json>' },
      media: { usage: 'claw-browser [global options] set media <light|dark|no-preference>' },
      credentials: { usage: 'claw-browser [global options] set credentials <username> <password>' },
      device: { usage: 'claw-browser [global options] set device <name>' },
      geo: { usage: 'claw-browser [global options] set geo <lat> <lng>' },
      timezone: { usage: 'claw-browser [global options] set timezone <timezoneId>' },
      locale: { usage: 'claw-browser [global options] set locale <locale>' },
      permissions: { usage: 'claw-browser [global options] set permissions <permission...>' },
      content: { usage: 'claw-browser [global options] set content <html>' },
      useragent: { usage: 'claw-browser [global options] set useragent <ua>' },
      'user-agent': { usage: 'claw-browser [global options] set useragent <ua>' },
    },
  },
  get: {
    usage: 'claw-browser [global options] get <text|html|value|attr|title|url|cdp-url|count|box|styles> ...',
    subcommands: {
      text: { usage: 'claw-browser [global options] get text <selector>' },
      html: { usage: 'claw-browser [global options] get html <selector>' },
      value: { usage: 'claw-browser [global options] get value <selector>' },
      attr: { usage: 'claw-browser [global options] get attr <selector> <attr>' },
      title: { usage: 'claw-browser [global options] get title' },
      url: { usage: 'claw-browser [global options] get url' },
      'cdp-url': { usage: 'claw-browser [global options] get cdp-url' },
      count: { usage: 'claw-browser [global options] get count <selector>' },
      box: { usage: 'claw-browser [global options] get box <selector>' },
      styles: { usage: 'claw-browser [global options] get styles <selector>' },
    },
  },
  is: {
    usage: 'claw-browser [global options] is <visible|enabled|checked> <selector>',
    subcommands: {
      visible: { usage: 'claw-browser [global options] is visible <selector>' },
      enabled: { usage: 'claw-browser [global options] is enabled <selector>' },
      checked: { usage: 'claw-browser [global options] is checked <selector>' },
    },
  },
  eval: { usage: 'claw-browser [global options] eval <script>' },
  evaluate: { usage: 'claw-browser [global options] evaluate <script>' },
  state: {
    usage: 'claw-browser [global options] state <save|load|list|show|rename|clear|clean> ...',
    subcommands: {
      save: { usage: 'claw-browser [global options] state save [path]' },
      load: { usage: 'claw-browser [global options] state load <path>' },
      list: { usage: 'claw-browser [global options] state list' },
      show: { usage: 'claw-browser [global options] state show <file>' },
      rename: { usage: 'claw-browser [global options] state rename <old> <new>' },
      clear: { usage: 'claw-browser [global options] state clear [name|--all]' },
      clean: { usage: 'claw-browser [global options] state clean --older-than <days>' },
    },
  },
  tab: {
    usage: 'claw-browser [global options] tab [list|new|close|switch|<target>] ...',
    description: 'Target formats: tN | <label> | <tab-id>',
    subcommands: {
      list: { usage: 'claw-browser [global options] tab list' },
      new: { usage: 'claw-browser [global options] tab new [--label <name>] [url]' },
      close: { usage: 'claw-browser [global options] tab close [<target>]' },
      switch: { usage: 'claw-browser [global options] tab switch <target>', description: 'Target formats: tN | <label> | <tab-id>' },
    },
  },
  tabs: { usage: 'claw-browser [global options] tab [list|new|close|switch|<target>] ...', description: 'Alias of tab.' },
  window: {
    usage: 'claw-browser [global options] window new [--label <name>] [url]',
    subcommands: {
      new: { usage: 'claw-browser [global options] window new [--label <name>] [url]' },
    },
  },
  frame: { usage: 'claw-browser [global options] frame <selector|main>' },
  dialog: {
    usage: 'claw-browser [global options] dialog <accept|dismiss|status> [text]',
    subcommands: {
      accept: { usage: 'claw-browser [global options] dialog accept [text]' },
      dismiss: { usage: 'claw-browser [global options] dialog dismiss' },
      status: { usage: 'claw-browser [global options] dialog status' },
    },
  },
  route: { usage: 'claw-browser [global options] route <pattern>' },
  unroute: { usage: 'claw-browser [global options] unroute [pattern]' },
  responsebody: { usage: 'claw-browser [global options] responsebody <requestId>' },
  inspect: { usage: 'claw-browser [global options] inspect' },
  highlight: { usage: 'claw-browser [global options] highlight <selector>' },
  selectall: { usage: 'claw-browser [global options] selectall' },
  bringtofront: { usage: 'claw-browser [global options] bringtofront' },
  find: { usage: 'claw-browser [global options] find <kind> <query> <action> [value]' },
  clipboard: {
    usage: 'claw-browser [global options] clipboard <read|write> [text]',
    subcommands: {
      read: { usage: 'claw-browser [global options] clipboard read' },
      write: { usage: 'claw-browser [global options] clipboard write <text>' },
    },
  },
  stream: {
    usage: 'claw-browser [global options] stream <enable|disable|status> ...',
    subcommands: {
      enable: { usage: 'claw-browser [global options] stream enable [--port <port>]' },
      disable: { usage: 'claw-browser [global options] stream disable' },
      status: { usage: 'claw-browser [global options] stream status' },
    },
  },
  site: { usage: 'claw-browser [global options] site <list|search|info|update|<adapter>> [args...]' },
  session: {
    usage: 'claw-browser session <start|stop|stop_all|list> [session]',
    description: 'Manage daemon sessions.',
    subcommands: {
      start: { usage: 'claw-browser session start [session]', description: 'Start a daemon session.' },
      stop: { usage: 'claw-browser session stop [session]', description: 'Stop a daemon session.' },
      stop_all: { usage: 'claw-browser session stop_all', description: 'Stop all active daemon sessions.' },
      list: { usage: 'claw-browser session list', description: 'List active sessions with status details.' },
    },
  },
  profiles: { usage: 'claw-browser profiles', description: 'List local Chrome profiles.' },
  connect: { usage: 'claw-browser connect <port|url> [session]' },
  console: { usage: 'claw-browser [global options] console [--clear]' },
  errors: { usage: 'claw-browser [global options] errors [--clear]' },
  install: { usage: 'claw-browser [global options] install' },
  upgrade: { usage: 'claw-browser [global options] upgrade' },
  chat: { usage: 'claw-browser [global options] chat [prompt]' },
  help: { usage: 'claw-browser help' },
  version: { usage: 'claw-browser version' },
};

export const HELP_USAGE_LINES: string[] = [
  'claw-browser <command> [args...]                # Use default session',
  'claw-browser --session <name> <command> [...]   # Use session via flag',
  'claw-browser session start [session]            # Start daemon session',
  'claw-browser session stop [session]             # Stop daemon session',
  'claw-browser session stop_all                   # Stop all active sessions',
  'claw-browser connect <port|url> [session]       # Connect session to CDP',
  'claw-browser session list                       # List active sessions',
];

export const HELP_OVERVIEW_SECTIONS: HelpOverviewSection[] = [
  {
    title: 'Navigation',
    items: [
      { command: 'navigate, open, goto <url>', summary: 'Navigate to URL' },
      { command: 'back', summary: 'Go back' },
      { command: 'forward', summary: 'Go forward' },
      { command: 'reload', summary: 'Reload page' },
    ],
  },
  {
    title: 'Interaction',
    items: [
      { command: 'click <selector>', summary: 'Click element' },
      { command: 'fill <selector> <text>', summary: 'Fill input field' },
      { command: 'type <selector> <text>', summary: 'Type text into element' },
      { command: 'press <key>', summary: 'Press key (Enter, Escape, Ctrl+K, ...)' },
      { command: 'hover <selector>', summary: 'Hover over element' },
      { command: 'scroll [direction] [amount]', summary: 'Scroll page or element' },
      { command: 'mouse <subcommand>', summary: 'Low-level mouse events' },
    ],
  },
  {
    title: 'Information',
    items: [
      { command: 'snapshot [options]', summary: 'Get accessibility tree' },
      { command: 'screenshot [selector]', summary: 'Take screenshot' },
      { command: 'eval, evaluate <script>', summary: 'Evaluate JavaScript in current page' },
      { command: 'get <field>', summary: 'Get text/html/value/attr/title/url/count/box/styles' },
      { command: 'is <field> <selector>', summary: 'visible/enabled/checked' },
      { command: 'find <kind> <q> <action>', summary: 'Find then act (click/fill/type/gettext/count)' },
      { command: 'site <subcommand>', summary: 'Manage and run site adapters' },
      { command: 'console [--clear]', summary: 'Show console messages' },
      { command: 'errors [--clear]', summary: 'Show runtime errors' },
    ],
  },
  {
    title: 'Tabs',
    items: [
      { command: 'tab', summary: 'List tabs (shows short id, tabId, and optional label)' },
      { command: 'tab new [url]', summary: 'Open a new tab (optionally navigate)' },
      { command: 'tab new --label docs [url]', summary: 'Open a new tab with a label' },
      { command: 'tab <target>', summary: 'Switch active tab (target: tN|label|tab-id)' },
      { command: 'tab close [target]', summary: 'Close tab (default: active)' },
      { command: 'window new', summary: 'Open a new window' },
    ],
  },
  {
    title: 'Session',
    items: [
      { command: 'session start [session]', summary: 'Start daemon session' },
      { command: 'session stop [session]', summary: 'Stop daemon session' },
      { command: 'session stop_all', summary: 'Stop all active daemon sessions' },
      { command: 'connect <port|url> [session]', summary: 'Connect session to an existing Chrome CDP endpoint' },
      { command: 'session list', summary: 'List active sessions' },
      { command: 'profiles', summary: 'List local Chrome profiles' },
    ],
  },
  {
    title: 'Misc',
    items: [
      { command: 'frame <selector>', summary: 'Scope to iframe' },
      { command: 'frame main', summary: 'Return to main frame' },
      { command: 'dialog <status|accept|dismiss>', summary: 'Manage JS dialogs' },
      { command: 'route <pattern>', summary: 'Add request route' },
      { command: 'unroute [pattern]', summary: 'Remove route(s)' },
      { command: 'network requests', summary: 'Show tracked requests' },
      { command: 'network request <id>', summary: 'Show one request' },
      { command: 'responsebody <id>', summary: 'Get response body for request' },
      { command: 'inspect', summary: 'Print current CDP endpoint' },
      { command: 'highlight <selector>', summary: 'Highlight an element' },
      { command: 'scrollintoview <selector>', summary: 'Scroll element into view' },
      { command: 'selectall', summary: 'Select all text/content on page' },
      { command: 'bringtofront', summary: 'Bring current tab to front' },
      { command: 'clipboard <read|write>', summary: 'Clipboard read/write' },
      { command: 'chat [prompt]', summary: 'Chat command (placeholder)' },
      { command: 'install', summary: 'Install command (managed externally)' },
      { command: 'upgrade', summary: 'Upgrade command (managed externally)' },
      { command: 'help', summary: 'Show this help' },
      { command: 'version', summary: 'Show version' },
      { command: '<command> --help', summary: 'Show scoped command help' },
    ],
  },
];

export const HELP_EXAMPLES = {
  direct: [
    'claw-browser open https://example.com',
    'claw-browser click "button[type=\'submit\']"',
    'claw-browser press Enter',
    'claw-browser scroll down 600',
    'claw-browser scrollintoview "#submit"',
    'claw-browser mouse move 300 220',
    'claw-browser snapshot',
    'claw-browser eval "location.href"',
    'claw-browser snapshot -i -u',
    'claw-browser snapshot -s "#main" -d 4',
    'claw-browser set media dark',
    'claw-browser set timezone Asia/Shanghai',
    'claw-browser set locale zh-CN',
    'claw-browser set geo 31.2304 121.4737',
    'claw-browser set content "<h1>Hello</h1>"',
    'claw-browser find text "Sign in" click',
    'claw-browser network requests --method GET',
    'claw-browser dialog status',
    'claw-browser site list',
    'claw-browser site xhs/note --note_id 123',
    'claw-browser tab list',
    'claw-browser tab new --label docs https://claw-browser.dev',
    'claw-browser tab t2',
    'claw-browser tab close docs',
    'claw-browser window new',
    'claw-browser --tab-id <tab-id> eval "document.title"',
    'claw-browser connect 9222',
    'claw-browser connect ws://127.0.0.1:9222/devtools/browser/abc123',
    'claw-browser open --help',
    'claw-browser network request --help',
    'claw-browser session --help',
  ],
  session: [
    'claw-browser session start my-session',
    'claw-browser --session my-session navigate https://example.com',
    'claw-browser --session my-session click "button[type=\'submit\']"',
    'claw-browser --session my-session snapshot',
    'claw-browser session stop my-session',
  ],
};
