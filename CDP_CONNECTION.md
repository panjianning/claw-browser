# Connecting to Existing Chrome CDP

claw-browser can connect to an already-running Chrome instance via Chrome DevTools Protocol (CDP).

## Prerequisites

You need to launch Chrome with remote debugging enabled:

### Windows
```bash
# Launch Chrome with debugging port
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

### macOS
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### Linux
```bash
google-chrome --remote-debugging-port=9222
```

## Connecting via claw-browser

Currently, claw-browser's CDP connection is not yet fully implemented in the TypeScript port. However, based on the original Rust implementation, it should work like this:

### Connect Command (when implemented)
```bash
# Connect to local Chrome on port 9222
claw-browser connect 9222

# Or specify as URL
claw-browser connect ws://localhost:9222
```

### Using --cdp Flag
```bash
# All commands will use the CDP connection
claw-browser --cdp 9222 navigate https://example.com
claw-browser --cdp 9222 snapshot
```

## Current Status

Looking at the claw-browser source code:

1. **`src/cli/commands.ts`**: Doesn't have `connect` command yet
2. **`src/cdp/browser.ts`**: Has `BrowserManager.connect()` method ready
3. **`src/browser/lifecycle.ts`**: Has logic to handle `cdpUrl` and `cdpPort` in `handleLaunch()`

## Implementation TODO

To enable CDP connection, the following needs to be added:

1. Add `connect` command to `src/cli/commands.ts`:
```typescript
case 'connect': {
  const endpoint = rest[0];
  if (!endpoint) {
    throw new MissingArgumentsError('connect', 'connect <port|url>');
  }
  
  // Check if it's a URL or port
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://') || 
      endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return { id, action: 'launch', cdpUrl: endpoint };
  } else {
    const port = parseInt(endpoint, 10);
    if (isNaN(port)) {
      throw new InvalidValueError('Invalid port or URL', 'connect <port|url>');
    }
    return { id, action: 'launch', cdpPort: port };
  }
}
```

2. Add `--cdp` flag parsing to `src/index.ts`:
```typescript
} else if (arg === '--cdp') {
  flags.cdp = args[i + 1];
  i++;
}
```

3. Add `cdp` to Flags interface in `src/types/commands.ts`:
```typescript
export interface Flags {
  // ... existing flags
  cdp?: string;  // Add this
}
```

4. Pass CDP info when launching:
```typescript
if (flags.cdp) {
  // Parse as port or URL
  const isUrl = flags.cdp.startsWith('ws://') || flags.cdp.startsWith('wss://') ||
                flags.cdp.startsWith('http://') || flags.cdp.startsWith('https://');
  
  if (isUrl) {
    command.cdpUrl = flags.cdp;
  } else {
    command.cdpPort = parseInt(flags.cdp, 10);
  }
}
```

## Workaround

Until the `connect` command is implemented, you can manually construct the command:

```bash
# This should work once the command is added to parseCommand
node .\dist\index.js connect 9222
```

The underlying CDP connection code in `BrowserManager.connect()` is already implemented and working.