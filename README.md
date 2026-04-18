# claw-browser

TypeScript migration of `agent-browser` (Rust) with CLI compatibility as the primary goal.

## Current focus

- Keep command format compatible with `agent-browser` README
- Support `--tab-id` for per-tab operations and concurrent workflows
- Close migration gaps command-by-command

Migration tracker: [MIGRATION_STATUS.md](./MIGRATION_STATUS.md)

## Development

```bash
# install
pnpm install

# build
pnpm run build

# dev watch
pnpm run dev
```

## Quick usage

```bash
claw-browser open https://example.com
claw-browser snapshot -i
claw-browser click @e2
claw-browser get title
claw-browser tab list
claw-browser close
```

## Architecture

1. CLI process parses user commands and sends JSON RPC over local IPC
2. Daemon process maintains browser/session/tab state
3. CDP layer executes browser actions
4. Browser modules implement command handlers and output shaping

## License

Apache-2.0
