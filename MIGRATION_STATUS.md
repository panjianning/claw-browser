# claw-browser Migration Status (vs `agent-browser` README)

Updated: 2026-04-19

## Implemented and verified at CLI/parser level

- Core navigation: `open|goto|navigate`, `back`, `forward`, `reload`, `close`
- Element actions: `click`, `dblclick`, `focus`, `fill`, `type`, `press|key`, `keydown`, `keyup`, `keyboard type|inserttext`, `hover`, `scroll`, `scrollintoview`, `select`, `check`, `uncheck`, `drag`, `upload`
- Snapshot/screenshot: `snapshot` (including `-i`), `screenshot` (path/full/annotate/format/quality/dir args parsed)
- Wait: `wait` (ms/selector), `wait --text`, `wait --url`, `wait --load`, `wait --fn`
- Get/is family:
  - `get text|html|value|attr|title|url|cdp-url|count|box|styles`
  - `is visible|enabled|checked`
- State commands: `state save|load|list|show|rename|clear|clean`
- Tabs/windows:
  - `tab`, `tab list`, `tab new [url] [--label]`, `tab <n>`, `tab <tN>`, `tab <tabId>`, `tab <label>`, `tab close [...]`
  - `window new [url] [--label]`
- Cookies/storage:
  - `cookies`, `cookies set`, `cookies clear`
  - `storage local|session [key]`, `storage local|session set <k> <v>`, `storage local|session clear`
  - legacy form `storage get|set|clear ...` is also accepted
- Settings:
  - `set viewport`, `set offline`, `set headers`, `set media`, `set credentials`, `set device`, `set geo` (parsed; partial runtime support)
- Session/CDP: `start`, `stop`, `connect`, `--tab-id`
- Additional parser compatibility: `network ...`, `find ...`, `frame ...`, `dialog ...`, `stream ...`, `install`, `upgrade`, `chat`

## Fully migrated runtime behavior in this pass

- Snapshot refs now populate daemon `refMap` correctly, so `@eN` references are reusable in follow-up commands.
- `--tab-id` is injected for action commands and resolved in executor, enabling per-tab concurrency routing.
- `get`/`is`/`cookies`/`storage`/`set offline|headers|viewport` actions are wired to executable handlers instead of placeholder errors.
- `cdp-url` now returns active CDP websocket endpoint.
- `eval` supports `-b` and `--stdin`.

## Still partial or placeholder

- Semantic locator execution (`find role/text/...`) currently parses but does not execute semantic lookup actions.
- Full network tooling (`network route/unroute/requests/request`, HAR detail workflow) remains partial.
- Frame/dialog/stream/install/upgrade/chat are parser-compatible; runtime handlers are still placeholders.
- Some advanced features from upstream README (diff/profiler/trace/console/errors/auth vault/etc.) remain to be fully ported.

