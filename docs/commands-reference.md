# claw-browser Commands Reference (Current)

This document lists the commands currently parsed and supported by the TypeScript `claw-browser` CLI in this repository.

Source of truth:

- `src/index.ts` (entry commands, global flags, session commands)
- `src/cli/commands.ts` (main command parser)
- `src/cli/site.ts` (`site` subcommands)
- `src/browser/executor.ts` (runtime action support status)

## Global usage

```bash
claw-browser <command> [args...]
claw-browser --session <name> <command> [args...]
```

## Global flags

- `--session <name>`: select session
- `--tab-id <tab-id>` / `--tabid <tab-id>`: route command to a specific tab
- `--profile <path-or-name>`: browser profile
- `--cdp <port|url>`: connect daemon commands to CDP target
- `--headed`: launch headed mode (default)
- `--headless`: launch headless mode (overrides `--headed`)
- `--json` or `-j`: JSON output
- `--default-timeout <ms>`: default timeout for wait-family commands
- `--annotate`: screenshot annotation mode
- `--provider <name>`: provider selector
- `--device <name>`: device selector
- `--headers <json>`: default headers for navigation
- `--help` / `-h`: show scoped help for command/subcommand (for example, `open --help`, `network request --help`, `session --help`)

## Built-in process commands

- `help`, `--help`, `-h`
- `version`, `--version`, `-v`
- `session start [session]`
- `session stop [session]`
- `session stop_all`
- `connect <port|url> [session]`
- `session list`
- `profiles`

## Navigation

- `open <url>`
- `goto <url>`
- `navigate <url>`
- `back`
- `forward`
- `reload`

## Element interaction

- `click <selector> [--new-tab]`
- `dblclick <selector>`
- `fill <selector> <text>`
- `setvalue <selector> <value>` (alias form, mapped to fill action)
- `type <selector> <text>`
- `hover <selector>`
- `focus <selector>`
- `check <selector>`
- `uncheck <selector>`
- `select <selector> <value...>`
- `drag <source> <target>`
- `upload <selector> <files...>`
- `download <selector> <path>`

## Keyboard and mouse

- `press <key>`
- `key <key>` (alias)
- `keydown <key>`
- `keyup <key>`
- `keyboard type <text>`
- `keyboard inserttext <text>`
- `mouse move <x> <y>`
- `mouse down [button]`
- `mouse up [button]`
- `mouse wheel <dy> [dx]`

## Scrolling

- `scroll [direction] [amount] [--selector <sel>]`
- `scrollintoview <selector>`
- `scrollinto <selector>` (alias)

## Wait

- `wait` (sleep for default timeout)
- `wait <ms>`
- `wait <selector> [--state <visible|hidden|attached|detached>]`
- `wait --text <text>`
- `wait --fn <expression>`
- `wait --url <pattern>`
- `wait --load <state>`
- `waitforselector <selector>` (alias to `wait <selector>`)

## Snapshot and capture

- `snapshot [--interactive|-i] [--compact|-c] [--urls|-u] [--depth|-d <n>] [--selector|-s <sel>]`
- `screenshot [selector|path] [--full-page|-f|--full] [--annotate] [--screenshot-dir <dir>] [--screenshot-format <fmt>] [--screenshot-quality <q>]`
- `pdf <path>`

## Get and is

- `get text <selector>`
- `get html <selector>`
- `get value <selector>`
- `get attr <selector> <attr>`
- `get title`
- `get url`
- `get cdp-url`
- `get count <selector>`
- `get box <selector>`
- `get styles <selector>`
- `is visible <selector>`
- `is enabled <selector>`
- `is checked <selector>`

## JavaScript and utility actions

- `eval <script>`
- `evaluate <script>`
- `evaluate --stdin`
- `evaluate -b <base64>`
- `find <kind> <query> <action> [value]`
- `inspect`
- `highlight <selector>`
- `selectall`
- `clipboard read`
- `clipboard write <text>`
- `responsebody <requestId>`
- `bringtofront`

## Network, routing, console, errors

- `route <pattern>`
- `unroute [pattern]`
- `network route <url> [--abort|--body <json>]`
- `network unroute [pattern]`
- `network requests [--filter <s>] [--type <resourceType>] [--method <m>] [--status <code>]`
- `network request <requestId>`
- `network har start`
- `network har stop [path]`
- `console [--clear]`
- `errors [--clear]`

## Cookies and storage

- `cookies`
- `cookies get`
- `cookies set <name> <value>`
- `cookies clear`
- `storage get <local|session> [key]`
- `storage set <local|session> <key> <value>`
- `storage clear <local|session>`
- `storage local [key|set|clear ...]`
- `storage session [key|set|clear ...]`

## Emulation and environment (`set`)

- `set viewport <width> <height> [scale]`
- `set offline [on|off]`
- `set headers <json>`
- `set media [dark|light]`
- `set credentials <username> <password>`
- `set device <name>`
- `set geo <lat> <lng>`
- `set timezone <timezoneId>`
- `set locale <locale>`
- `set permissions <permission...>`
- `set content <html>`
- `set useragent <ua>`
- `set user-agent <ua>` (alias)

## Tabs, windows, frames, dialogs

- `tab`
- `tabs` (alias)
- `tab list`
- `tab new [url] [--label <name>]`
- `tab close [tN|label|tab-id]`
- `tab switch <target>` (`target` = `tN` | tab label | tab-id)
- `tab <target>` (direct switch; same target formats)
- `window new [url] [--label <name>]`
- `frame <selector>`
- `frame main`
- `dialog status`
- `dialog accept [text]`
- `dialog dismiss`

## Session state commands

- `state save [path]`
- `state load <path>`
- `state list`
- `state show <file>`
- `state rename <old> <new>`
- `state clear [name] [--all]`
- `state clean --older-than <days>`

## Stream commands

- `stream enable [--port <n>]`
- `stream disable`
- `stream status`

## Site commands

- `site` (same as `site list`)
- `site list`
- `site search <query>`
- `site info <adapter-name>`
- `site update`
- `site run <adapter-name> [adapter-args...]`
- `site <adapter-name> [adapter-args...]` (direct shorthand for run)

Notes:

- Adapter metadata is discovered from local and community adapter folders.
- If adapter has a `domain` and no `--tab-id` is provided, domain tab pool logic is used.

Use `session stop_all` to stop all active sessions.

## Parsed but not implemented (current TS runtime)

These commands are parsed by CLI, but currently return a runtime not-implemented error in `src/browser/executor.ts`:

- `install`
- `upgrade`
- `chat`
