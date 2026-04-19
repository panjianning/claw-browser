# claw-browser

TypeScript implementation of the `claw-browser` CLI protocol.

Goal: keep command and response compatibility with `claw-browser` where practical, while closing migration gaps incrementally.

Migration tracker: [MIGRATION_STATUS.md](./MIGRATION_STATUS.md)

## Install and Build

```bash
pnpm install
pnpm run build
```

Run from source:

```bash
node ./dist/index.js --help
```

## Quick Start

```bash
claw-browser open https://example.com
claw-browser snapshot -i
claw-browser click @e2
claw-browser fill @e3 "hello"
claw-browser get title
claw-browser screenshot
claw-browser close
```

## Core Commands

```bash
claw-browser open <url>
claw-browser click <selector-or-ref>
claw-browser fill <selector-or-ref> <text>
claw-browser type <selector-or-ref> <text>
claw-browser snapshot
claw-browser screenshot [path]
claw-browser evaluate <script>
claw-browser close
```

Tabs:

```bash
claw-browser tab list
claw-browser tab new [url]
claw-browser tab <tN|label|tab-id>
claw-browser tab close [tN|label|tab-id]
```

Wait:

```bash
claw-browser wait 1000
claw-browser wait "#submit"
claw-browser waitforurl "**/dashboard"
claw-browser waitforloadstate networkidle
```

## Sessions and Data Directory

Each session runs a background daemon and keeps isolated browser state.

- Default session: `default`
- Session switch: `claw-browser --session <name> ...`
- Runtime files: `~/.claw-browser/`

Key files:

- `<session>.pid`
- `<session>.sock` (Unix) or `<session>.port` (Windows)
- `<session>.version`

## Site Adapters

List and run adapters:

```bash
claw-browser site list
claw-browser site update
claw-browser site <adapter-name> [args...]
```

Local adapter directory:

```text
~/.claw-browser/sites
```

Community adapter directory:

```text
~/.claw-browser/agent-sites
```

### Domain Tab Pooling for `site`

For adapters with a declared `domain`, `claw-browser` now manages per-domain tab leases:

- Reuse an idle tab for that domain first.
- If all leased tabs are busy, open a new tab.
- Enforce a per-domain max tab count.
- If at max, wait in a queue.
- Auto-close tabs created temporarily for the adapter when the run finishes.

Configure max tabs per domain:

```bash
CLAW_BROWSER_SITE_MAX_TABS_PER_DOMAIN=3 claw-browser site xhs/note --note_id 123
```

Default: `2`.

## Compatibility Notes

- Command surface targets `claw-browser` compatibility.
- Some commands are not implemented yet in this TypeScript version.
- `install` and `upgrade` are managed by the Rust `claw-browser` binary.

## Architecture

1. CLI process parses user commands and sends JSON RPC over local IPC
2. Daemon process maintains browser/session/tab state
3. CDP layer executes browser actions
4. Browser modules implement command handlers and output shaping

## License

Apache-2.0
