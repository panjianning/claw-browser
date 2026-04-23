// Response types for claw-browser commands
export interface BaseResponse {
  id: string;
  success: boolean;
  error?: string;
}

export interface NavigateResponse extends BaseResponse {
  url: string;
}

export interface ClickResponse extends BaseResponse {
  selector: string;
}

export interface FillResponse extends BaseResponse {
  selector: string;
  value: string;
}

export interface TypeResponse extends BaseResponse {
  selector: string;
  text: string;
}

// Accessibility tree node for snapshots
export interface AXNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  keyshortcuts?: string;
  roledescription?: string;
  valuetext?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: 'true' | 'false' | 'mixed';
  pressed?: 'true' | 'false' | 'mixed';
  level?: number;
  valuemin?: number;
  valuemax?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
  children?: AXNode[];
  nodeId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  ignoredReasons?: Array<{ name: string; value?: string }>;
}

export interface SnapshotResponse extends BaseResponse {
  data: {
    snapshot: string;
    origin: string;
    refs: Record<string, { role: string; name: string }>;
  };
}

export interface ScreenshotResponse extends BaseResponse {
  data: string; // base64 encoded image
  format: 'png' | 'jpeg';
  width?: number;
  height?: number;
}

// Cookie types
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface GetCookiesResponse extends BaseResponse {
  cookies: Cookie[];
}

export interface SetCookieResponse extends BaseResponse {
  success: boolean;
}

export interface ClearCookiesResponse extends BaseResponse {
  success: boolean;
}

// Storage types
export interface StorageItem {
  key: string;
  value: string;
}

export interface GetStorageResponse extends BaseResponse {
  items: StorageItem[];
}

export interface SetStorageResponse extends BaseResponse {
  success: boolean;
}

export interface ClearStorageResponse extends BaseResponse {
  success: boolean;
}

// Tab types
export interface Tab {
  id: string;
  url: string;
  title: string;
  active: boolean;
  index: number;
}

export interface ListTabsResponse extends BaseResponse {
  tabs: Tab[];
}

export interface NewTabResponse extends BaseResponse {
  tabId: string;
  url?: string;
}

export interface CloseTabResponse extends BaseResponse {
  success: boolean;
}

export interface SwitchTabResponse extends BaseResponse {
  tabId: string;
}

// State types
export interface SaveStateResponse extends BaseResponse {
  path: string;
  size: number;
}

export interface LoadStateResponse extends BaseResponse {
  restored: boolean;
}

// Network types
export interface RouteResponse extends BaseResponse {
  pattern: string;
  matched: boolean;
}

// Wait responses
export interface WaitResponse extends BaseResponse {
  timeout: boolean;
  elapsed: number;
}

// Response union type
export type AnyResponse =
  | BaseResponse
  | NavigateResponse
  | ClickResponse
  | FillResponse
  | TypeResponse
  | SnapshotResponse
  | ScreenshotResponse
  | GetCookiesResponse
  | SetCookieResponse
  | ClearCookiesResponse
  | GetStorageResponse
  | SetStorageResponse
  | ClearStorageResponse
  | ListTabsResponse
  | NewTabResponse
  | CloseTabResponse
  | SwitchTabResponse
  | SaveStateResponse
  | LoadStateResponse
  | RouteResponse
  | WaitResponse;
