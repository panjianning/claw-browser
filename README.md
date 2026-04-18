# claw-browser

Fast browser automation CLI for AI agents - TypeScript port of agent-browser.

## Status

This is a work-in-progress translation of the Rust agent-browser project to TypeScript. Currently implementing Phase 1: Foundation.

### Completed

- ✅ Project structure and configuration
- ✅ Type definitions (CDP, commands, responses)
- ✅ Command parsing module
- ✅ IPC connection module (Unix socket + TCP)
- ✅ CLI entry point

### In Progress

- 🚧 Daemon process implementation
- 🚧 CDP client implementation
- 🚧 Browser operations
- 🚧 State management
- 🚧 HTTP/WebSocket servers

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode (watch)
npm run dev
```

## Usage

Once complete, the CLI will work identically to the Rust version:

```bash
# Start a session
claw-browser start my-session

# Send commands
claw-browser my-session navigate https://example.com
claw-browser my-session click "button[type='submit']"
claw-browser my-session snapshot

# Stop session
claw-browser stop my-session
```

## Architecture

The project follows the same architecture as the Rust version:

1. **CLI Process** - Parses commands and connects to daemon via IPC
2. **Daemon Process** - Long-running background process managing browser
3. **CDP Client** - WebSocket client for Chrome DevTools Protocol
4. **Browser Operations** - Command execution engine

## Translation Progress

See the [translation plan](../../.claude/plans/proud-tumbling-donut.md) for details.

## License

Apache-2.0
