// CDP (Chrome DevTools Protocol) types
// Based on cli/src/native/cdp/types.rs

// CDP message envelope
export interface CdpCommand {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
}

export interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: CdpError;
  method?: string;
  params?: unknown;
  sessionId?: string;
}

export interface CdpError {
  code?: number;
  message: string;
  data?: string;
}

// CDP events
export interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

// Target domain
export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
}

export interface GetTargetsResult {
  targetInfos: TargetInfo[];
}

export interface AttachToTargetParams {
  targetId: string;
  flatten: boolean;
}

export interface AttachToTargetResult {
  sessionId: string;
}

export interface SetDiscoverTargetsParams {
  discover: boolean;
}

export interface CreateTargetParams {
  url: string;
}

export interface CreateTargetResult {
  targetId: string;
}

// Page domain
export interface NavigateParams {
  url: string;
  referrer?: string;
  transitionType?: string;
  frameId?: string;
}

export interface NavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface CaptureScreenshotParams {
  format?: 'jpeg' | 'png' | 'webp';
  quality?: number;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  };
  fromSurface?: boolean;
  captureBeyondViewport?: boolean;
}

export interface CaptureScreenshotResult {
  data: string; // base64
}

// DOM domain
export interface GetDocumentResult {
  root: DOMNode;
}

export interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: DOMNode[];
  attributes?: string[];
  documentURL?: string;
  baseURL?: string;
  publicId?: string;
  systemId?: string;
  internalSubset?: string;
  xmlVersion?: string;
  name?: string;
  value?: string;
  pseudoType?: string;
  shadowRootType?: string;
  frameId?: string;
  contentDocument?: DOMNode;
  shadowRoots?: DOMNode[];
  templateContent?: DOMNode;
  pseudoElements?: DOMNode[];
  importedDocument?: DOMNode;
  distributedNodes?: DOMNode[];
  isSVG?: boolean;
}

export interface QuerySelectorParams {
  nodeId: number;
  selector: string;
}

export interface QuerySelectorResult {
  nodeId: number;
}

export interface GetBoxModelParams {
  nodeId?: number;
  backendNodeId?: number;
  objectId?: string;
}

export interface Quad {
  0: number; 1: number;
  2: number; 3: number;
  4: number; 5: number;
  6: number; 7: number;
}

export interface BoxModel {
  content: Quad;
  padding: Quad;
  border: Quad;
  margin: Quad;
  width: number;
  height: number;
}

export interface GetBoxModelResult {
  model: BoxModel;
}

// Input domain
export interface DispatchMouseEventParams {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  modifiers?: number;
  timestamp?: number;
  button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
  buttons?: number;
  clickCount?: number;
  force?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  deltaX?: number;
  deltaY?: number;
  pointerType?: 'mouse' | 'pen';
}

export interface DispatchKeyEventParams {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  modifiers?: number;
  timestamp?: number;
  text?: string;
  unmodifiedText?: string;
  keyIdentifier?: string;
  code?: string;
  key?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  autoRepeat?: boolean;
  isKeypad?: boolean;
  isSystemKey?: boolean;
  location?: number;
  commands?: string[];
}

// Runtime domain
export interface EvaluateParams {
  expression: string;
  objectGroup?: string;
  includeCommandLineAPI?: boolean;
  silent?: boolean;
  contextId?: number;
  returnByValue?: boolean;
  generatePreview?: boolean;
  userGesture?: boolean;
  awaitPromise?: boolean;
  throwOnSideEffect?: boolean;
  timeout?: number;
  disableBreaks?: boolean;
  replMode?: boolean;
  allowUnsafeEvalBlockedByCSP?: boolean;
  uniqueContextId?: string;
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
  customPreview?: CustomPreview;
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: PropertyPreview[];
  entries?: EntryPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  value?: string;
  valuePreview?: ObjectPreview;
  subtype?: string;
}

export interface EntryPreview {
  key?: ObjectPreview;
  value: ObjectPreview;
}

export interface CustomPreview {
  header: string;
  bodyGetterId?: string;
}

export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string;
  url?: string;
  stackTrace?: StackTrace;
  exception?: RemoteObject;
  executionContextId?: number;
  exceptionMetaData?: Record<string, unknown>;
}

export interface StackTrace {
  description?: string;
  callFrames: CallFrame[];
  parent?: StackTrace;
  parentId?: StackTraceId;
}

export interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface StackTraceId {
  id: string;
  debuggerId?: string;
}

export interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

// Network domain
export interface RequestPattern {
  urlPattern?: string;
  resourceType?: string;
  interceptionStage?: 'Request' | 'HeadersReceived';
}

export interface SetRequestInterceptionParams {
  patterns: RequestPattern[];
}

export interface InterceptedRequest {
  interceptionId: string;
  request: Request;
  frameId: string;
  resourceType: string;
  isNavigationRequest: boolean;
  isDownload?: boolean;
  redirectUrl?: string;
  authChallenge?: AuthChallenge;
  responseErrorReason?: string;
  responseStatusCode?: number;
  responseHeaders?: Headers[];
  requestId?: string;
}

export interface Request {
  url: string;
  urlFragment?: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: PostDataEntry[];
  mixedContentType?: string;
  initialPriority: string;
  referrerPolicy: string;
  isLinkPreload?: boolean;
  trustTokenParams?: TrustTokenParams;
  isSameSite?: boolean;
}

export interface PostDataEntry {
  bytes?: string;
}

export interface TrustTokenParams {
  type: string;
  refreshPolicy: string;
  issuers?: string[];
}

export interface AuthChallenge {
  source?: 'Server' | 'Proxy';
  origin: string;
  scheme: string;
  realm: string;
}

export interface Headers {
  name: string;
  value: string;
}

export interface ContinueInterceptedRequestParams {
  interceptionId: string;
  errorReason?: string;
  rawResponse?: string;
  url?: string;
  method?: string;
  postData?: string;
  headers?: Record<string, string>;
  authChallengeResponse?: AuthChallengeResponse;
}

export interface AuthChallengeResponse {
  response: 'Default' | 'CancelAuth' | 'ProvideCredentials';
  username?: string;
  password?: string;
}

// Accessibility domain
export interface GetFullAXTreeParams {
  depth?: number;
  frameId?: string;
  max_depth?: number;
}

export interface GetFullAXTreeResult {
  nodes: AXNodeData[];
}

export interface AXNodeData {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: AXProperty[];
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface AXValue {
  type: string;
  value?: unknown;
  relatedNodes?: AXRelatedNode[];
  sources?: AXValueSource[];
}

export interface AXRelatedNode {
  backendDOMNodeId: number;
  idref?: string;
  text?: string;
}

export interface AXValueSource {
  type: string;
  value?: AXValue;
  attribute?: string;
  attributeValue?: AXValue;
  superseded?: boolean;
  nativeSource?: string;
  nativeSourceValue?: AXValue;
  invalid?: boolean;
  invalidReason?: string;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

// Storage domain
export interface GetCookiesParams {
  browserContextId?: string;
}

export interface GetCookiesResult {
  cookies: CdpCookie[];
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  priority?: string;
  sameParty?: boolean;
  sourceScheme?: string;
  sourcePort?: number;
}

export interface SetCookiesParams {
  cookies: CookieParam[];
  browserContextId?: string;
}

export interface CookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  priority?: string;
  sameParty?: boolean;
  sourceScheme?: string;
  sourcePort?: number;
}

export interface ClearCookiesParams {
  browserContextId?: string;
}

export interface GetDOMStorageItemsParams {
  storageId: StorageId;
}

export interface StorageId {
  securityOrigin?: string;
  storageKey?: string;
  isLocalStorage: boolean;
}

export interface GetDOMStorageItemsResult {
  entries: Array<[string, string]>;
}

export interface SetDOMStorageItemParams {
  storageId: StorageId;
  key: string;
  value: string;
}

export interface RemoveDOMStorageItemParams {
  storageId: StorageId;
  key: string;
}

export interface ClearDOMStorageParams {
  storageId: StorageId;
}
