# Fix for --headed Flag Issue

## Problem
The `--headed` flag was not working in claw-browser. When running:
```bash
node .\dist\index.js navigate https://baidu.com --headed
```

The browser would still launch in headless mode instead of showing the visible browser window.

## Root Cause
The issue was in multiple places:

1. **`src/index.ts` - parseFlags()**: The `--headed` flag was not being parsed from command-line arguments
2. **`src/index.ts` - daemon options**: The `headed` option was hardcoded to `false` in both the `start` command and regular command execution
3. **`src/index.ts` - cleanArgs()**: The `--headed` flag needed to be treated as a boolean flag (no value)
4. **`src/types/commands.ts`**: The `Flags` interface was missing the `headed` property
5. **`src/browser/lifecycle.ts`**: The `parseLaunchOptions()` function wasn't reading the `AGENT_BROWSER_HEADED` environment variable

## Solution
The fix involved 5 changes:

### 1. Updated Flags Interface
```typescript
// src/types/commands.ts
export interface Flags {
  provider?: string;
  device?: string;
  headers?: string;
  defaultTimeout?: number;
  cliAnnotate?: boolean;
  headed?: boolean;  // Added
}
```

### 2. Updated parseFlags() to Capture --headed
```typescript
// src/index.ts
} else if (arg === '--headed') {
  flags.headed = true;
}
```

### 3. Updated Daemon Options to Use Flag Value
```typescript
// src/index.ts - start command
const opts: connection.DaemonOptions = {
  headed: flags.headed || false,  // Changed from: headed: false
  debug: process.env.AGENT_BROWSER_DEBUG === '1',
};

// src/index.js - regular commands
const opts: connection.DaemonOptions = {
  headed: flags.headed || false,  // Changed from: headed: false
  debug: false,
};
```

### 4. Updated cleanArgs() to Handle Boolean Flags
```typescript
// src/index.ts
const booleanFlags = ['--headed', '--annotate'];

if (booleanFlags.includes(arg)) {
  i++;
  continue;
}
```

### 5. Updated parseLaunchOptions() to Read Environment Variable
```typescript
// src/browser/lifecycle.ts
function parseLaunchOptions(cmd: any): LaunchOptions {
  // ...
  
  // Check AGENT_BROWSER_HEADED env var for headed mode
  const headedFromEnv = process.env.AGENT_BROWSER_HEADED === '1';
  
  return {
    headless: cmd.headless !== undefined ? Boolean(cmd.headless) : !headedFromEnv,
    // ...
  };
}
```

## How It Works Now

The complete flow:

1. User passes `--headed` flag on command line
2. `parseFlags()` captures it and sets `flags.headed = true`
3. `cleanArgs()` removes it from command args (so it doesn't interfere with command parsing)
4. Daemon options are created with `headed: flags.headed || false`
5. When spawning daemon, `connection/index.ts` sets `AGENT_BROWSER_HEADED=1` environment variable
6. Daemon starts and `parseLaunchOptions()` reads the env var
7. Sets `headless = !headedFromEnv` (so `headless = false`)
8. Chrome launches WITHOUT `--headless=new` flag
9. Browser window appears!

## Testing

```bash
cd claw-browser
npm run build
node .\dist\index.js navigate https://baidu.com --headed
```

The browser should now launch with a visible window instead of headless mode.

## Important Note

The `--headed` flag affects the **daemon startup**, not individual commands. Once a daemon is running, you cannot switch between headed and headless mode without restarting the daemon. The daemon will detect version mismatches and restart automatically if needed.

To explicitly restart with headed mode:
```bash
# Stop existing daemon
node .\dist\index.js stop default

# Start new command with --headed
node .\dist\index.js navigate https://baidu.com --headed