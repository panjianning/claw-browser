# claw-browser

A TypeScript implementation of `vercel-labs/agent-browser`, optimized for persistent session management and concurrent multi-tab operations.

## Install

``` bash
npm install -g claw-browser
```

## Quick Start

```bash
claw-browser tab new https://example.com
claw-browser tab list
claw-browser --tab-id <tab-id-or-prefix> snapshot -i
claw-browser --tab-id <tab-id-or-prefix> click @e2
claw-browser --tab-id <tab-id-or-prefix> fill @e3 "hello"
claw-browser --tab-id <tab-id-or-prefix> get title
claw-browser --tab-id <tab-id-or-prefix> screenshot
```

## Google Workflow (Recommended)

When you run multiple tabs concurrently, always bind each action with `--tab-id` so commands do not hit the wrong tab.

```bash
# 1) Create a tab (same URL behavior as open: "google.com" will become "https://google.com")
claw-browser tab new google.com

# 2) Get the tab id from tab list (or from "tab new" output)
claw-browser tab list

# 3) Inspect page and collect refs
claw-browser --tab-id <tab-id-or-prefix> snapshot -i

# 4) Interact on the exact tab
claw-browser --tab-id <tab-id-or-prefix> fill "@e21" "text"
claw-browser --tab-id <tab-id-or-prefix> press Enter
# or click the button ref instead of pressing Enter
claw-browser --tab-id <tab-id-or-prefix> click "@e17"

# 5) Observe results
claw-browser --tab-id <tab-id-or-prefix> get title
claw-browser --tab-id <tab-id-or-prefix> eval "document.body.innerText"
```

Notes:

- In PowerShell, quote refs like `"@e21"` to avoid parser issues.
- `--tab-id` supports unique prefix matching (for example `3896AD`).
- If multiple tabs share the same prefix, command fails with an "ambiguous prefix" error; use a longer prefix or full tab id.

## Core Commands

```bash
claw-browser --tab-id <tab-id-or-prefix> open <url>
claw-browser --tab-id <tab-id-or-prefix> click <selector-or-ref>
claw-browser --tab-id <tab-id-or-prefix> fill <selector-or-ref> <text>
claw-browser --tab-id <tab-id-or-prefix> type <selector-or-ref> <text>
claw-browser --tab-id <tab-id-or-prefix> snapshot
claw-browser --tab-id <tab-id-or-prefix> screenshot [path]
claw-browser --tab-id <tab-id-or-prefix> evaluate <script>
```

Tabs:

```bash
claw-browser tab list
claw-browser tab new [url]
claw-browser tab <tN|label|tab-id>
claw-browser tab close [tN|label|tab-id]
```

Most browser commands now require `--tab-id` (except tab-management commands like `tab new/list/switch/close`, plus `window new`).

For multi-tab or concurrent agent usage:

```bash
claw-browser --tab-id <tab-id-or-prefix> <command> ...
```

Wait:

```bash
claw-browser --tab-id <tab-id-or-prefix> wait 1000
claw-browser --tab-id <tab-id-or-prefix> wait "#submit"
claw-browser --tab-id <tab-id-or-prefix> wait --url "**/dashboard"
claw-browser --tab-id <tab-id-or-prefix> wait --load networkidle
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
~/.claw-browser/claw-sites
```

* Inspired by [bb-browser](https://github.com/epiral/bb-browser/)

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


## Dev

```bash
npm install
npm run build
```

Run from source:

```bash
node ./dist/index.js --help
```
