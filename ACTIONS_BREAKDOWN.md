# actions.rs Breakdown Strategy

## Overview

The `cli/src/native/actions.rs` file is **8,547 lines** - too large to translate in one pass. This document outlines a strategy to break it into logical, independent modules.

## File Structure Analysis

### Core Components

1. **DaemonState** (lines 192-305)
   - Central state management structure
   - ~120 fields including browser, CDP client, ref map, trackers, etc.
   - Lifecycle methods (new, reset, handlers)

2. **Command Router** (line 1139: `execute_command`)
   - Giant match statement dispatching 120+ commands
   - Routes to individual handlers
   - Wraps results in success/error responses

3. **Command Handlers** (~120 async functions)
   - handle_launch, handle_navigate, handle_click, etc.
   - Each handler follows pattern: `async fn handle_X(cmd: &Value, state: &mut DaemonState) -> Result<Value, String>`

## Proposed Module Breakdown

### Phase 3.1: Core State & Router (Priority 1)
**File:** `src/browser/state.ts` + `src/browser/executor.ts`

**Purpose:** Central daemon state and command dispatch router

**Components:**
- `DaemonState` class (all 120 fields)
- `executeCommand()` - Main dispatcher
- `successResponse()` / `errorResponse()` helpers
- Background task management (fetch handler, dialog handler)

**Lines:** ~500 (state definition + router + helpers)

**Dependencies:** All other action modules will import DaemonState

---

### Phase 3.2: Browser Lifecycle (Priority 2)
**File:** `src/browser/lifecycle.ts`

**Purpose:** Browser launch, connection, and teardown

**Handlers:**
- `handleLaunch()` - Launch Chrome with options
- `handleConnect()` - Connect to existing CDP endpoint
- `handleClose()` - Close browser
- `autoLaunch()` - Auto-launch browser on first command
- `launchHash()` - Detect when relaunch is needed
- `launchOptionsFromEnv()` - Parse env vars to LaunchOptions
- `tryAutoRestoreState()` - Restore encrypted state on launch

**Lines:** ~400

**Dependencies:** `src/cdp/browser.ts`, `src/cdp/client.ts`, state encryption module

---

### Phase 3.3: Navigation & Page Operations (Priority 3)
**File:** `src/browser/navigation.ts`

**Purpose:** Page navigation and basic page operations

**Handlers:**
- `handleNavigate()` - Navigate to URL with wait strategies
- `handleUrl()` - Get current URL
- `handleTitle()` - Get page title
- `handleContent()` - Get page HTML
- `handleBack()` - Navigate back
- `handleForward()` - Navigate forward
- `handleReload()` - Reload page
- `handleBringToFront()` - Bring tab to front

**Lines:** ~200

**Dependencies:** `src/cdp/browser.ts`

---

### Phase 3.4: Snapshot & Screenshot (Priority 4)
**File:** `src/browser/capture.ts`

**Purpose:** Snapshot and screenshot operations

**Handlers:**
- `handleSnapshot()` - Generate accessibility tree
- `handleScreenshot()` - Capture screenshot
- `handlePdf()` - Generate PDF

**Lines:** ~300

**Dependencies:** `src/cdp/accessibility.ts`, screenshot utilities

---

### Phase 3.5: Element Interactions (Priority 5)
**File:** `src/browser/interactions.ts`

**Purpose:** All element interaction commands (click, fill, type, etc.)

**Handlers:**
- `handleClick()` - Click element
- `handleDblclick()` - Double-click element
- `handleFill()` - Fill input/textarea
- `handleType()` - Type text
- `handlePress()` - Press key combination
- `handleHover()` - Hover over element
- `handleScroll()` - Scroll element into view
- `handleSelect()` - Select option from dropdown
- `handleCheck()` / `handleUncheck()` - Toggle checkboxes
- `handleFocus()` - Focus element
- `handleClear()` - Clear input
- `handleSelectAll()` - Select all text
- `handleScrollIntoView()` - Scroll element into viewport
- `handleTap()` - Mobile tap gesture
- `handleDrag()` - Drag and drop
- `handleSwipe()` - Mobile swipe gesture

**Lines:** ~800

**Dependencies:** `src/cdp/browser.ts`, interaction helpers, ref map

---

### Phase 3.6: Element Queries (Priority 6)
**File:** `src/browser/queries.ts`

**Purpose:** Element state queries (getText, getAttribute, isVisible, etc.)

**Handlers:**
- `handleGetText()` - Get element text content
- `handleGetAttribute()` - Get element attribute
- `handleIsVisible()` - Check visibility
- `handleIsEnabled()` - Check enabled state
- `handleIsChecked()` - Check checkbox state
- `handleBoundingBox()` - Get element bounding box
- `handleInnerText()` - Get innerText
- `handleInnerHtml()` - Get innerHTML
- `handleInputValue()` - Get input value
- `handleSetValue()` - Set input value
- `handleCount()` - Count matching elements
- `handleStyles()` - Get computed styles

**Lines:** ~400

**Dependencies:** `src/cdp/browser.ts`, ref map

---

### Phase 3.7: Locators (Priority 7)
**File:** `src/browser/locators.ts`

**Purpose:** All locator strategies (getByRole, getByText, etc.)

**Handlers:**
- `handleGetByRole()` - Get element by ARIA role + name
- `handleGetByText()` - Get element by text content
- `handleGetByLabel()` - Get element by label
- `handleGetByPlaceholder()` - Get element by placeholder
- `handleGetByAltText()` - Get element by alt text
- `handleGetByTitle()` - Get element by title
- `handleGetByTestId()` - Get element by test ID
- `handleNth()` - Get nth element from set
- `handleSemanticLocator()` - Semantic locator support
- `buildRoleSelector()` - Helper to build ARIA selector

**Lines:** ~400

**Dependencies:** ref map, snapshot

---

### Phase 3.8: Wait Operations (Priority 8)
**File:** `src/browser/waits.ts`

**Purpose:** All wait/polling operations

**Handlers:**
- `handleWait()` - Generic wait dispatcher
- `waitForSelector()` - Wait for selector to appear
- `waitForUrl()` - Wait for URL pattern
- `waitForText()` - Wait for text content
- `waitForFunction()` - Wait for JS function to return true
- `pollUntilTrue()` - Generic polling utility
- `handleWaitForUrl()` - Command wrapper
- `handleWaitForLoadState()` - Wait for page load state
- `handleWaitForFunction()` - Command wrapper
- `handleWaitForDownload()` - Wait for download

**Lines:** ~300

**Dependencies:** `src/cdp/browser.ts`

---

### Phase 3.9: Mouse & Keyboard (Priority 9)
**File:** `src/browser/input.ts`

**Purpose:** Low-level mouse and keyboard input

**Handlers:**
- `handleMouse()` - Legacy mouse command
- `handleKeyboard()` - Legacy keyboard command
- `handleInputMouse()` - CDP Input.dispatchMouseEvent
- `handleInputKeyboard()` - CDP Input.dispatchKeyEvent
- `handleInputTouch()` - CDP Input.dispatchTouchEvent
- `handleKeyDown()` - Key down event
- `handleKeyUp()` - Key up event
- `handleInsertText()` - Insert text at cursor
- `handleMouseMove()` - Mouse move event
- `handleMouseDown()` - Mouse down event
- `handleMouseUp()` - Mouse up event
- `handleWheel()` - Mouse wheel event
- `parseKeyChord()` - Parse key combinations (Ctrl+A, etc.)
- `mouseButtonMask()` - Convert button name to bitmask
- `buildMouseEventParams()` - Build CDP mouse event params

**Lines:** ~500

**Dependencies:** DaemonState mouse tracking

---

### Phase 3.10: Tab Management (Priority 10)
**File:** `src/browser/tabs.ts`

**Purpose:** Tab/window/target management

**Handlers:**
- `handleTabList()` - List all tabs
- `handleTabNew()` - Create new tab
- `handleTabSwitch()` - Switch to tab by ID
- `handleTabClose()` - Close tab
- `handleWindowNew()` - Open new window

**Lines:** ~150

**Dependencies:** `src/cdp/browser.ts`

---

### Phase 3.11: Frame Management (Priority 11)
**File:** `src/browser/frames.ts`

**Purpose:** iframe operations

**Handlers:**
- `handleFrame()` - Switch to iframe by selector
- `handleMainFrame()` - Switch back to main frame
- `executeSubAction()` - Execute command in iframe context

**Lines:** ~250

**Dependencies:** `src/cdp/browser.ts`, iframe session tracking

---

### Phase 3.12: Network & Storage (Priority 12)
**File:** `src/browser/network-ops.ts`

**Purpose:** Network, cookies, and storage operations (command wrappers)

**Handlers:**
- `handleCookiesGet()` - Get cookies
- `handleCookiesSet()` - Set cookies
- `handleCookiesClear()` - Clear cookies
- `handleStorageGet()` - Get storage
- `handleStorageSet()` - Set storage
- `handleStorageClear()` - Clear storage
- `handleSetContent()` - Set page HTML
- `handleHeaders()` - Set extra HTTP headers
- `handleOffline()` - Toggle offline mode
- `handleConsole()` - Get console messages
- `handleErrors()` - Get JavaScript errors

**Lines:** ~200

**Dependencies:** `src/cdp/cookies.ts`, `src/cdp/storage.ts`, `src/cdp/network.ts`

---

### Phase 3.13: HAR Recording (Priority 13)
**File:** `src/browser/har.ts`

**Purpose:** HAR recording and export

**Handlers:**
- `handleHarStart()` - Start HAR recording
- `handleHarStop()` - Stop and export HAR
- `harEntryToJson()` - Convert HarEntry to HAR 1.2 JSON
- `harExtractHeaders()` - Extract headers from CDP format
- `harCdpProtocolToHttpVersion()` - Normalize protocol name
- `harParseQueryString()` - Parse URL query string
- `harParseRequestCookies()` - Parse Cookie header
- `harComputeTimings()` - Calculate HAR timing phases
- `harWallTimeToRfc3339()` - Convert timestamp to ISO 8601
- `harOutputPath()` - Resolve output path
- `getHarDir()` - Get HAR output directory
- `harBrowserMetadata()` - Get browser metadata for HAR

**Lines:** ~600

**Dependencies:** EventTracker (HarEntry collection)

---

### Phase 3.14: Route Interception (Priority 14)
**File:** `src/browser/routing.ts`

**Purpose:** Request/response interception (route/unroute)

**Handlers:**
- `handleRoute()` - Add route pattern with mock response
- `handleUnroute()` - Remove route pattern
- `resolveFetchPaused()` - Handle Fetch.requestPaused events
- `buildFetchPatterns()` - Build Fetch.enable patterns
- `buildFetchEnableParams()` - Build Fetch.enable params
- `handleRequests()` - Get tracked requests (filtering)
- `handleRequestDetail()` - Get request detail
- `matchesStatusFilter()` - Filter requests by status code

**Lines:** ~400

**Dependencies:** `src/cdp/network.ts`, Fetch API interception

---

### Phase 3.15: Download Management (Priority 15)
**File:** `src/browser/downloads.ts`

**Purpose:** Download tracking and management

**Handlers:**
- `handleDownload()` - Set download directory
- `handleWaitForDownload()` - Wait for download to complete
- `handleUpload()` - Upload file via input[type=file]

**Lines:** ~250

**Dependencies:** CDP Page.setDownloadBehavior

---

### Phase 3.16: JavaScript Evaluation (Priority 16)
**File:** `src/browser/evaluation.ts`

**Purpose:** JavaScript evaluation and exposure

**Handlers:**
- `handleEvaluate()` - Evaluate JavaScript
- `handleEvalHandle()` - Evaluate and return object handle
- `handleExpose()` - Expose Node.js function to page
- `handleAddScript()` - Add script tag to page
- `handleAddInitScript()` - Add script to run on every page
- `handleAddStyle()` - Add style tag to page
- `handleFind()` - Find elements via JS evaluation

**Lines:** ~300

**Dependencies:** `src/cdp/browser.ts`

---

### Phase 3.17: Media & Viewport (Priority 17)
**File:** `src/browser/viewport.ts`

**Purpose:** Viewport, user agent, media features, device emulation

**Handlers:**
- `handleViewport()` - Set viewport size
- `handleUserAgent()` - Set user agent
- `handleSetMedia()` - Set color scheme, reduced motion, etc.
- `handleDevice()` - Emulate device preset
- `handleTimezone()` - Set timezone
- `handleLocale()` - Set locale
- `handleGeolocation()` - Set geolocation
- `handlePermissions()` - Grant permissions
- `handleClipboard()` - Read/write clipboard

**Lines:** ~400

**Dependencies:** CDP Emulation domain

---

### Phase 3.18: Dialogs (Priority 18)
**File:** `src/browser/dialogs.ts`

**Purpose:** JavaScript dialog handling (alert, confirm, prompt)

**Handlers:**
- `handleDialog()` - Accept/dismiss dialog
- Dialog auto-dismiss background task

**Lines:** ~100

**Dependencies:** DaemonState pending_dialog tracking

---

### Phase 3.19: State Persistence (Priority 19)
**File:** `src/browser/state-ops.ts`

**Purpose:** State save/load operations

**Handlers:**
- `handleStateSave()` - Save encrypted state
- `handleStateLoad()` - Load encrypted state

**Lines:** ~50

**Dependencies:** State encryption module (Phase 4)

---

### Phase 3.20: Diff Operations (Priority 20)
**File:** `src/browser/diff.ts`

**Purpose:** Snapshot and screenshot diffing

**Handlers:**
- `handleDiffSnapshot()` - Compare two snapshots
- `handleDiffUrl()` - Compare snapshots from two URLs
- `handleDiffScreenshot()` - Compare two screenshots

**Lines:** ~250

**Dependencies:** Diff module, snapshot, screenshot

---

### Phase 3.21: Tracing & Recording (Priority 21)
**File:** `src/browser/tracing.ts`

**Purpose:** Performance tracing and video recording

**Handlers:**
- `handleTraceStart()` - Start CDP trace
- `handleTraceStop()` - Stop CDP trace
- `handleProfilerStart()` - Start JS profiler
- `handleProfilerStop()` - Stop JS profiler
- `handleRecordingStart()` - Start video recording (ffmpeg)
- `handleRecordingStop()` - Stop video recording
- `handleRecordingRestart()` - Restart recording with new settings
- `handleVideoStart()` - Alias for recording
- `handleVideoStop()` - Alias for recording

**Lines:** ~400

**Dependencies:** CDP Tracing, CDP Profiler, ffmpeg process

---

### Phase 3.22: Streaming (Priority 22)
**File:** `src/browser/streaming.ts`

**Purpose:** WebSocket streaming server management

**Handlers:**
- `handleStreamEnable()` - Start stream server
- `handleStreamDisable()` - Stop stream server
- `handleStreamStatus()` - Get stream status
- `handleScreencastStart()` - Start screencast
- `handleScreencastStop()` - Stop screencast
- `currentStreamStatus()` - Get current stream metadata
- `streamFilePath()` / `writeStreamFile()` / `removeStreamFile()` - Session file helpers
- `engineFilePath()` / `writeEngineFile()` / `removeEngineFile()` - Engine file helpers
- `providerFilePath()` / `writeProviderFile()` / `removeProviderFile()` - Provider file helpers

**Lines:** ~300

**Dependencies:** Stream server module (Phase 5)

---

### Phase 3.23: Authentication (Priority 23)
**File:** `src/browser/auth.ts`

**Purpose:** Auth credential storage and login automation

**Handlers:**
- `handleCredentialsSet()` - Store credentials
- `handleCredentialsGet()` - Retrieve credentials
- `handleCredentialsDelete()` - Delete credentials
- `handleCredentialsList()` - List all credentials
- `handleAuthShow()` - Show credentials in UI
- `handleAuthSave()` - Save auth flow as reusable config
- `handleAuthLogin()` - Auto-fill and submit login form
- `waitForAnySelector()` - Wait for any of multiple selectors
- `handleHttpCredentials()` - Set HTTP auth credentials (proxy)

**Lines:** ~600

**Dependencies:** Credential store, form automation

---

### Phase 3.24: Advanced Actions (Priority 24)
**File:** `src/browser/advanced.ts`

**Purpose:** Miscellaneous advanced actions

**Handlers:**
- `handleHighlight()` - Highlight element
- `handleDispatch()` - Dispatch custom CDP command
- `handleMultiSelect()` - Select multiple options
- `handleResponseBody()` - Get response body by request ID
- `handlePause()` - Pause execution (for debugging)
- `handleInspect()` - Open DevTools inspector

**Lines:** ~200

**Dependencies:** Various

---

### Phase 3.25: Mobile/WebDriver (Priority 25)
**File:** `src/browser/mobile.ts`

**Purpose:** Mobile-specific and WebDriver actions

**Handlers:**
- `handleLaunchIos()` - Launch iOS app via Appium
- `handleLaunchSafari()` - Launch Safari via SafariDriver
- `handleDeviceList()` - List iOS devices
- WebDriver backend operations

**Lines:** ~300

**Dependencies:** Appium, SafariDriver modules (Phase 4+)

---

### Phase 3.26: Confirmation Policy (Priority 26)
**File:** `src/browser/policy.ts`

**Purpose:** Action confirmation policy enforcement

**Handlers:**
- `handleConfirm()` - Confirm pending action
- `handleDeny()` - Deny pending action
- Policy checking before destructive actions

**Lines:** ~100

**Dependencies:** DaemonState policy field

---

## Implementation Order

### Stage 1: Core Infrastructure (Weeks 1-2)
- Phase 3.1: State & Router ⭐️
- Phase 3.2: Browser Lifecycle ⭐️
- Phase 3.3: Navigation ⭐️
- Phase 3.4: Snapshot & Screenshot ⭐️

### Stage 2: Primary Interactions (Weeks 3-4)
- Phase 3.5: Element Interactions ⭐️
- Phase 3.6: Element Queries ⭐️
- Phase 3.7: Locators ⭐️
- Phase 3.8: Wait Operations ⭐️

### Stage 3: Input & Management (Weeks 5-6)
- Phase 3.9: Mouse & Keyboard
- Phase 3.10: Tab Management
- Phase 3.11: Frame Management
- Phase 3.12: Network & Storage

### Stage 4: Advanced Features (Weeks 7-8)
- Phase 3.13: HAR Recording
- Phase 3.14: Route Interception
- Phase 3.15: Download Management
- Phase 3.16: JavaScript Evaluation

### Stage 5: Configuration & Media (Weeks 9-10)
- Phase 3.17: Media & Viewport
- Phase 3.18: Dialogs
- Phase 3.19: State Persistence
- Phase 3.20: Diff Operations

### Stage 6: Observability & Extras (Weeks 11-12)
- Phase 3.21: Tracing & Recording
- Phase 3.22: Streaming
- Phase 3.23: Authentication
- Phase 3.24: Advanced Actions
- Phase 3.25: Mobile/WebDriver
- Phase 3.26: Confirmation Policy

## Module Dependencies Graph

```
state.ts (DaemonState)
  ↓
executor.ts (executeCommand router)
  ↓
├─ lifecycle.ts (launch, close)
├─ navigation.ts (navigate, back, forward)
├─ capture.ts (snapshot, screenshot)
├─ interactions.ts (click, fill, type)
├─ queries.ts (getText, isVisible)
├─ locators.ts (getByRole, getByText)
├─ waits.ts (waitFor*)
├─ input.ts (mouse, keyboard)
├─ tabs.ts (tab management)
├─ frames.ts (iframe switching)
├─ network-ops.ts (cookies, storage)
├─ har.ts (HAR recording)
├─ routing.ts (route/unroute)
├─ downloads.ts (download tracking)
├─ evaluation.ts (evaluate, expose)
├─ viewport.ts (viewport, device)
├─ dialogs.ts (alert, confirm)
├─ state-ops.ts (save/load state)
├─ diff.ts (snapshot/screenshot diff)
├─ tracing.ts (CDP trace, video)
├─ streaming.ts (WebSocket stream)
├─ auth.ts (credentials, login)
├─ advanced.ts (misc actions)
├─ mobile.ts (iOS, Safari)
└─ policy.ts (confirm/deny)
```

## Translation Guidelines

### Common Patterns

1. **Command Handler Signature**
   ```typescript
   async function handleX(cmd: any, state: DaemonState): Promise<any> {
     // Extract params from cmd
     // Validate
     // Execute via CDP
     // Return result
   }
   ```

2. **Error Handling**
   ```typescript
   try {
     const result = await operation();
     return { success: true, result };
   } catch (err) {
     return { success: false, error: String(err) };
   }
   ```

3. **State Access**
   ```typescript
   // DaemonState is passed as mutable reference
   if (!state.browser) {
     throw new Error('Browser not launched');
   }
   const browser = state.browser;
   ```

4. **CDP Commands**
   ```typescript
   const result = await state.browser.client.sendCommand(
     'Page.navigate',
     { url },
     sessionId
   );
   ```

### Per-Module Checklist

For each module:
- [ ] Read Rust source for that module's handlers
- [ ] Create TypeScript file with matching structure
- [ ] Translate all handler functions
- [ ] Import/export types correctly
- [ ] Add to `executor.ts` command router
- [ ] Build and verify no TypeScript errors
- [ ] Test basic functionality
- [ ] Update `PHASE3_PROGRESS.md`

## Success Metrics

- All 120+ command handlers translated
- Clean TypeScript compilation
- Modular structure (26 files vs. 1 monolithic file)
- Each module < 600 lines (maintainable)
- Clear separation of concerns
- Easy to test individual modules

## Estimated Effort

- **Total Lines:** ~8,500
- **Modules:** 26
- **Average per module:** ~327 lines
- **Time per module:** 1-2 days
- **Total time:** 8-12 weeks

---

*This breakdown transforms the massive 8,547-line actions.rs into 26 focused, maintainable TypeScript modules.*
