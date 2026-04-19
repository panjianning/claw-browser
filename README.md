# claw-browser

A TypeScript implementation of `vercel-labs/agent-browser`, optimized for persistent session management and concurrent multi-tab operations.

## Install and Build

```bash
npm install
npm run build
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
- Default browser user data dir (when `--profile` is not set): `~/.claw-browser/browser/<session>`

Key files:

- `<session>.pid`
- `<session>.sock` (Unix) or `<session>.port` (Windows)
- `<session>.version`

Notes:

- `--profile <path>` sets Chrome `--user-data-dir` to the provided path.
- Without `--profile`, `claw-browser` now uses a persistent per-session profile at `~/.claw-browser/browser/<session>`.

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

