import type { CdpClient } from './client.js';

// ========================================================================================
// Role Classification Constants
// ========================================================================================

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'slider',
  'spinbutton',
  'switch',
  'scrollbar',
  'progressbar',
  'listbox',
  'option',
  'tree',
  'treeitem',
  'grid',
  'gridcell',
  'rowheader',
  'columnheader',
  'menubar',
  'tablist',
  'toolbar',
  'disclosure',
]);

const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'listitem',
  'article',
  'blockquote',
  'code',
  'definition',
  'figure',
  'img',
  'table',
  'time',
  'paragraph',
]);

const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF]/g;

// ========================================================================================
// Type Definitions
// ========================================================================================

export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  urls?: boolean;
}

interface AXValue {
  type: string;
  value?: string | number | boolean | null;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface GetAccessibilityTreeResult {
  nodes: AXNode[];
}

interface TreeNode {
  role: string;
  name: string;
  level?: number;
  checked?: string;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  valueText?: string;
  backendNodeId?: number;
  children: number[];
  parentIdx?: number;
  hasRef: boolean;
  refId?: string;
  depth: number;
  cursorInfo?: CursorElementInfo;
  url?: string;
}

interface CursorElementInfo {
  kind: string; // 'clickable' | 'focusable' | 'editable'
  hints: string[]; // ['cursor:pointer', 'onclick', 'tabindex', 'contenteditable']
  text: string;
  hiddenInputKind?: HiddenInputKind;
  hiddenInputChecked?: string;
}

enum HiddenInputKind {
  Radio = 'radio',
  Checkbox = 'checkbox',
}

interface RefMapEntry {
  backendNodeId?: number;
  role: string;
  name: string;
  url?: string;
}

class RefMap {
  private map = new Map<string, RefMapEntry>();

  add(
    refId: string,
    backendNodeId: number | undefined,
    role: string,
    name: string,
    url?: string
  ): void {
    this.map.set(refId, { backendNodeId, role, name, url });
  }

  entriesSorted(): Array<[string, RefMapEntry]> {
    return Array.from(this.map.entries()).sort((a, b) => {
      const numA = parseInt(a[0].replace(/\D/g, ''), 10);
      const numB = parseInt(b[0].replace(/\D/g, ''), 10);
      return numA - numB;
    });
  }

  toObject(): Record<string, { role: string; name: string; url?: string }> {
    const result: Record<string, { role: string; name: string; url?: string }> = {};
    for (const [refId, entry] of this.entriesSorted()) {
      result[refId] = {
        role: entry.role,
        name: entry.name,
        ...(entry.url && { url: entry.url }),
      };
    }
    return result;
  }
}

class RoleNameTracker {
  private counts = new Map<string, number>();
  private duplicates = new Map<string, number[]>();

  track(role: string, name: string, index: number): number {
    const key = `${role}:${name}`;
    const count = this.counts.get(key) || 0;
    this.counts.set(key, count + 1);

    if (count > 0) {
      if (!this.duplicates.has(key)) {
        this.duplicates.set(key, []);
      }
      this.duplicates.get(key)!.push(index);
    }

    return count;
  }

  getDuplicates(): Map<string, number[]> {
    return this.duplicates;
  }
}

// ========================================================================================
// Main Snapshot Function
// ========================================================================================

export async function takeSnapshot(
  client: CdpClient,
  sessionId: string,
  _iframeSessionsMap: Map<string, string>,
  options: SnapshotOptions = {}
): Promise<{ tree: string; refs: Record<string, { role: string; name: string; url?: string }> }> {
  const interactive = options.interactive ?? false;
  const compact = options.compact ?? false;
  const includeUrls = options.urls ?? false;

  const selectorBackendIds = options.selector
    ? await resolveSelectorBackendIds(client, sessionId, options.selector)
    : undefined;

  // Get accessibility tree from Chrome
  const axResult = (await client.sendCommand(
    'Accessibility.getFullAXTree',
    {},
    sessionId
  )) as GetAccessibilityTreeResult;

  const axNodes = axResult.nodes || [];

  // Build tree structure
  const [treeNodes, rootIndices] = buildTree(axNodes);

  const effectiveRoots = selectorBackendIds
    ? findEffectiveRoots(treeNodes, selectorBackendIds, options.selector || '')
    : rootIndices;

  // Collect cursor-interactive elements
  const cursorElements = await collectCursorInteractiveElements(
    client,
    sessionId,
    selectorBackendIds
  );

  // Promote hidden inputs (labels wrapping display:none radio/checkbox)
  promoteHiddenInputs(treeNodes, cursorElements);

  // Attach cursor info and URL to tree nodes
  for (const node of treeNodes) {
    if (node.backendNodeId && cursorElements.has(node.backendNodeId)) {
      node.cursorInfo = cursorElements.get(node.backendNodeId);
    }

    // Resolve URL for links
    if (includeUrls && node.role === 'link' && node.backendNodeId) {
      try {
        const result = await client.sendCommand(
          'DOM.resolveNode',
          { backendNodeId: node.backendNodeId },
          sessionId
        );
        const objectId = (result as any).object?.objectId;
        if (objectId) {
          const evalResult = await client.sendCommand(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: 'function() { return this.href; }',
              returnByValue: true,
            },
            sessionId
          );
          const href = (evalResult as any).result?.value;
          if (href && typeof href === 'string') {
            node.url = href;
          }
        }
      } catch {
        // URL resolution failed, skip
      }
    }
  }

  // Track role:name for ref assignment
  const roleNameTracker = new RoleNameTracker();
  const refMap = new RefMap();
  let nextRef = 1;

  // Assign refs to interactive/content elements
  for (let i = 0; i < treeNodes.length; i++) {
    const node = treeNodes[i];
    if (node.role.length === 0) continue;

    const isInteractive = INTERACTIVE_ROLES.has(node.role);
    const isContent = CONTENT_ROLES.has(node.role);
    const hasCursorInfo = node.cursorInfo !== undefined;

    if (!isInteractive && !isContent && !hasCursorInfo) {
      continue;
    }

    // Skip if name is empty for interactive elements
    if (isInteractive && node.name.length === 0 && !hasCursorInfo) {
      continue;
    }

    roleNameTracker.track(node.role, node.name, i);
    const refId = `e${nextRef++}`;

    node.hasRef = true;
    node.refId = refId;

    refMap.add(refId, node.backendNodeId, node.role, node.name, node.url);
  }

  // Build dedup set for cursor-interactive elements
  const dedupSet = new Set<string>();
  for (const [, entry] of refMap.entriesSorted()) {
    if (entry.name.length > 0) {
      dedupSet.add(entry.name.toLowerCase());
    }
  }

  // Filter cursor-interactive elements: deduplicate against ARIA tree names
  for (const node of treeNodes) {
    if (!node.cursorInfo) continue;
    if (node.hasRef) continue; // Already has ref from ARIA tree

    const text = node.cursorInfo.text.toLowerCase().trim();
    if (text.length === 0 || dedupSet.has(text)) {
      // Duplicate or empty, skip
      continue;
    }

    // Assign ref for unique cursor-interactive element
    const refId = `e${nextRef++}`;
    node.hasRef = true;
    node.refId = refId;

    refMap.add(refId, node.backendNodeId, node.cursorInfo.kind, node.cursorInfo.text);
    dedupSet.add(text);
  }

  // Render tree
  let output = '';
  for (const rootIdx of effectiveRoots) {
    output = renderTree(treeNodes, rootIdx, 0, output, options);
  }

  // Compact tree if needed
  if (compact) {
    output = compactTree(output, interactive);
  }

  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return {
      tree: interactive ? '(no interactive elements)' : '(empty page)',
      refs: refMap.toObject(),
    };
  }

  return {
    tree: trimmed,
    refs: refMap.toObject(),
  };
}

// ========================================================================================
// Cursor-Interactive Element Collection
// ========================================================================================

async function collectCursorInteractiveElements(
  client: CdpClient,
  sessionId: string,
  selectorBackendIds?: Set<number>
): Promise<Map<number, CursorElementInfo>> {
  // JavaScript to scan all cursor-interactive elements
  const scanJs = `
(function() {
  const elements = [];
  const all = document.querySelectorAll('*');

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const style = window.getComputedStyle(el);

    const hasCursorPointer = style.cursor === 'pointer';
    const hasOnClick = el.onclick !== null || el.hasAttribute('onclick');
    const hasTabIndex = el.hasAttribute('tabindex');
    const isEditable = el.isContentEditable || el.hasAttribute('contenteditable');

    if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) {
      continue;
    }

    // Mark with data attribute for backendNodeId resolution
    el.setAttribute('data-__ab-ci', i);

    // Collect text content
    let text = '';
    if (el.childNodes.length === 0 || (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)) {
      text = el.textContent?.trim() || '';
    } else {
      // Has children, use innerText for visible text only
      text = el.innerText?.trim() || '';
    }

    // Detect hidden input
    let hiddenInputType = null;
    let hiddenInputChecked = null;

    if (el.tagName === 'LABEL') {
      const input = el.querySelector('input[type="radio"], input[type="checkbox"]');
      if (input && window.getComputedStyle(input).display === 'none') {
        hiddenInputType = input.getAttribute('type');
        hiddenInputChecked = input.checked ? 'true' : 'false';
      }
    }

    elements.push({
      hasCursorPointer,
      hasOnClick,
      hasTabIndex,
      isEditable,
      text,
      hiddenInputType,
      hiddenInputChecked,
    });
  }

  return elements;
})();
`;

  const evalResult = await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: scanJs,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId
  );

  const elements = (evalResult as any).result?.value || [];

  // Resolve backendNodeIds via querySelectorAll
  const idxToBackend = new Map<number, number>();
  const doc = await client.sendCommand('DOM.getDocument', { depth: 0 }, sessionId);
  const rootNodeId = (doc as any)?.root?.nodeId;

  for (let i = 0; i < elements.length; i++) {
    if (!rootNodeId) {
      break;
    }
    try {
      const result = await client.sendCommand(
        'DOM.querySelector',
        { nodeId: rootNodeId, selector: `[data-__ab-ci="${i}"]` },
        sessionId
      );
      const nodeId = (result as any).nodeId;

      if (nodeId) {
        const describe = await client.sendCommand('DOM.describeNode', { nodeId }, sessionId);
        const backendNodeId = (describe as any)?.node?.backendNodeId;
        if (backendNodeId) {
          idxToBackend.set(i, backendNodeId);
        }
      }
    } catch {
      // Failed to resolve this element, skip
    }
  }

  // Clean up data attributes
  const cleanupJs = `
(function() {
  const marked = document.querySelectorAll('[data-__ab-ci]');
  for (let i = 0; i < marked.length; i++) {
    marked[i].removeAttribute('data-__ab-ci');
  }
})();
`;

  try {
    await client.sendCommand(
      'Runtime.evaluate',
      {
        expression: cleanupJs,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId
    );
  } catch (e) {
    console.error(`[claw-browser] Warning: failed to clean up data-__ab-ci attributes: ${e}`);
  }

  // Build map
  const map = new Map<number, CursorElementInfo>();

  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i];
    const backendNodeId = idxToBackend.get(i);

    if (!backendNodeId) continue;

    // Filter by selector if provided
    if (selectorBackendIds && !selectorBackendIds.has(backendNodeId)) {
      continue;
    }

    const hasCursorPointer = elem.hasCursorPointer ?? false;
    const hasOnClick = elem.hasOnClick ?? false;
    const hasTabIndex = elem.hasTabIndex ?? false;
    const isEditable = elem.isEditable ?? false;

    const kind =
      hasCursorPointer || hasOnClick ? 'clickable' : isEditable ? 'editable' : 'focusable';

    const hints: string[] = [];
    if (hasCursorPointer) hints.push('cursor:pointer');
    if (hasOnClick) hints.push('onclick');
    if (hasTabIndex) hints.push('tabindex');
    if (isEditable) hints.push('contenteditable');

    const text = elem.text?.trim() || '';

    const hiddenInputKind =
      elem.hiddenInputType === 'radio'
        ? HiddenInputKind.Radio
        : elem.hiddenInputType === 'checkbox'
          ? HiddenInputKind.Checkbox
          : undefined;

    const hiddenInputChecked = elem.hiddenInputChecked || undefined;

    map.set(backendNodeId, {
      kind,
      hints,
      text,
      hiddenInputKind,
      hiddenInputChecked,
    });
  }

  return map;
}

// ========================================================================================
// Tree Construction
// ========================================================================================

function buildTree(nodes: AXNode[]): [TreeNode[], number[]] {
  const treeNodes: TreeNode[] = [];
  const idToIdx = new Map<string, number>();

  // First pass: create TreeNode for each AXNode
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const role = extractAxString(node.role);
    const name = extractAxString(node.name);
    const valueText = extractAxStringOpt(node.value);

    const [level, checked, expanded, selected, disabled, required] = extractProperties(
      node.properties
    );

    if ((node.ignored && role !== 'RootWebArea') || role === 'InlineTextBox') {
      treeNodes.push(createEmptyNode());
      idToIdx.set(node.nodeId, i);
      continue;
    }

    treeNodes.push({
      role,
      name,
      level,
      checked,
      expanded,
      selected,
      disabled,
      required,
      valueText,
      backendNodeId: node.backendDOMNodeId,
      children: [],
      parentIdx: undefined,
      hasRef: false,
      refId: undefined,
      depth: 0,
      cursorInfo: undefined,
      url: undefined,
    });

    idToIdx.set(node.nodeId, i);
  }

  // Build parent-child relationships
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.childIds) {
      for (const childId of node.childIds) {
        const childIdx = idToIdx.get(childId);
        if (childIdx !== undefined) {
          treeNodes[i].children.push(childIdx);
          treeNodes[childIdx].parentIdx = i;
        }
      }
    }
  }

  // StaticText aggregation
  for (let i = 0; i < treeNodes.length; i++) {
    if (treeNodes[i].role.length === 0 || treeNodes[i].children.length === 0) {
      continue;
    }

    const childrenIndices = treeNodes[i].children.slice();

    // Aggregate continuous StaticText sequences
    let start = 0;
    while (start < childrenIndices.length) {
      if (treeNodes[childrenIndices[start]].role !== 'StaticText') {
        start++;
        continue;
      }

      let end = start + 1;
      while (end < childrenIndices.length && treeNodes[childrenIndices[end]].role === 'StaticText') {
        end++;
      }

      if (end > start + 1) {
        const aggregatedName = childrenIndices
          .slice(start, end)
          .map((idx) => treeNodes[idx].name)
          .join('');
        treeNodes[childrenIndices[start]].name = aggregatedName;

        for (let j = start + 1; j < end; j++) {
          clearNode(treeNodes[childrenIndices[j]]);
        }
      }

      start = end;
    }

    // Deduplicate redundant StaticText
    if (
      childrenIndices.length === 1 &&
      treeNodes[childrenIndices[0]].role === 'StaticText' &&
      treeNodes[i].name === treeNodes[childrenIndices[0]].name
    ) {
      clearNode(treeNodes[childrenIndices[0]]);
    }
  }

  // Set depths
  const isChild = new Array(treeNodes.length).fill(false);
  for (const node of treeNodes) {
    for (const childIdx of node.children) {
      isChild[childIdx] = true;
    }
  }

  const rootIndices: number[] = [];
  for (let i = 0; i < isChild.length; i++) {
    if (!isChild[i]) {
      rootIndices.push(i);
    }
  }

  function setDepth(nodes: TreeNode[], idx: number, depth: number): void {
    nodes[idx].depth = depth;
    const children = nodes[idx].children.slice();
    for (const childIdx of children) {
      setDepth(nodes, childIdx, depth + 1);
    }
  }

  for (const rootIdx of rootIndices) {
    setDepth(treeNodes, rootIdx, 0);
  }

  return [treeNodes, rootIndices];
}

// ========================================================================================
// Tree Rendering
// ========================================================================================

function renderTree(
  nodes: TreeNode[],
  idx: number,
  indent: number,
  output: string,
  options: SnapshotOptions
): string {
  const node = nodes[idx];

  // Skip empty/generic/statictext nodes
  if (
    node.role.length === 0 ||
    (node.role === 'generic' && !node.hasRef && node.children.length <= 1) ||
    (node.role === 'StaticText' && node.name.replace(INVISIBLE_CHARS, '').length === 0)
  ) {
    for (const childIdx of node.children) {
      output = renderTree(nodes, childIdx, indent, output, options);
    }
    return output;
  }

  // Depth limiting
  if (options.depth !== undefined && indent > options.depth) {
    return output;
  }

  const role = node.role;

  // Skip root WebArea wrapper
  if (role === 'RootWebArea' || role === 'WebArea') {
    for (const childIdx of node.children) {
      output = renderTree(nodes, childIdx, indent, output, options);
    }
    return output;
  }

  // Interactive mode: skip non-interactive
  if (options.interactive && !node.hasRef) {
    for (const childIdx of node.children) {
      output = renderTree(nodes, childIdx, indent, output, options);
    }
    return output;
  }

  const prefix = '  '.repeat(indent);
  let line = `${prefix}- ${role}`;

  // Display name
  const unescapedDisplayName =
    node.name.length > 0
      ? node.name
      : options.interactive && node.cursorInfo
        ? node.cursorInfo.text
        : node.name;

  if (unescapedDisplayName.length > 0) {
    const displayName = JSON.stringify(unescapedDisplayName).replace(INVISIBLE_CHARS, '');
    line += ` ${displayName}`;
  }

  // Properties
  const attrs: string[] = [];

  if (node.level !== undefined) attrs.push(`level=${node.level}`);
  if (node.checked !== undefined) attrs.push(`checked=${node.checked}`);
  if (node.expanded !== undefined) attrs.push(`expanded=${node.expanded}`);
  if (node.selected) attrs.push('selected');
  if (node.disabled) attrs.push('disabled');
  if (node.required) attrs.push('required');
  if (node.refId) attrs.push(`ref=${node.refId}`);
  if (node.url) attrs.push(`url=${node.url}`);

  if (attrs.length > 0) {
    line += ` [${attrs.join(', ')}]`;
  }

  // Cursor-interactive kind & hints
  if (node.cursorInfo) {
    line += ` ${node.cursorInfo.kind} [${node.cursorInfo.hints.join(', ')}]`;
  }

  // Value
  if (node.valueText && node.valueText.length > 0 && node.valueText !== node.name) {
    line += `: ${node.valueText}`;
  }

  output += line + '\n';

  for (const childIdx of node.children) {
    output = renderTree(nodes, childIdx, indent + 1, output, options);
  }

  return output;
}

// ========================================================================================
// Tree Compaction
// ========================================================================================

function compactTree(tree: string, interactive: boolean): string {
  const lines = tree.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return '';

  const keep = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('ref=') || line.includes(': ')) {
      keep[i] = true;

      // Mark ancestors
      const myIndent = countIndent(line);
      for (let j = i - 1; j >= 0; j--) {
        const ancestorIndent = countIndent(lines[j]);
        if (ancestorIndent < myIndent) {
          keep[j] = true;
          if (ancestorIndent === 0) break;
        }
      }
    }
  }

  const result = lines.filter((_, i) => keep[i]);
  const output = result.join('\n');

  if (output.trim().length === 0 && interactive) {
    return '(no interactive elements)';
  }

  return output;
}

function countIndent(line: string): number {
  const trimmed = line.trimStart();
  return Math.floor((line.length - trimmed.length) / 2);
}

// ========================================================================================
// Helper Functions
// ========================================================================================

function promoteHiddenInputs(
  treeNodes: TreeNode[],
  cursorElements: Map<number, CursorElementInfo>
): void {
  for (const node of treeNodes) {
    if (node.role !== 'LabelText' && node.role !== 'generic') {
      continue;
    }

    if (!node.backendNodeId) continue;

    const cursorInfo = cursorElements.get(node.backendNodeId);
    if (!cursorInfo) continue;

    if (cursorInfo.hiddenInputKind) {
      node.role = cursorInfo.hiddenInputKind === HiddenInputKind.Radio ? 'radio' : 'checkbox';

      if (node.name.length === 0 && cursorInfo.text.length > 0) {
        node.name = cursorInfo.text;
      }

      if (cursorInfo.hiddenInputChecked) {
        node.checked = cursorInfo.hiddenInputChecked;
      }
    }
  }
}

function extractAxString(value?: AXValue): string {
  if (!value || !value.value) return '';
  if (typeof value.value === 'string') return value.value;
  if (typeof value.value === 'number') return value.value.toString();
  if (typeof value.value === 'boolean') return value.value.toString();
  return '';
}

function extractAxStringOpt(value?: AXValue): string | undefined {
  if (!value || !value.value) return undefined;
  if (typeof value.value === 'string' && value.value.length > 0) return value.value;
  if (typeof value.value === 'number') return value.value.toString();
  return undefined;
}

type NodeProperties = [
  number | undefined, // level
  string | undefined, // checked
  boolean | undefined, // expanded
  boolean | undefined, // selected
  boolean | undefined, // disabled
  boolean | undefined, // required
];

function extractProperties(props?: AXProperty[]): NodeProperties {
  let level: number | undefined;
  let checked: string | undefined;
  let expanded: boolean | undefined;
  let selected: boolean | undefined;
  let disabled: boolean | undefined;
  let required: boolean | undefined;

  if (props) {
    for (const prop of props) {
      switch (prop.name) {
        case 'level':
          if (typeof prop.value.value === 'number') {
            level = prop.value.value;
          }
          break;
        case 'checked':
          if (typeof prop.value.value === 'string') {
            checked = prop.value.value;
          } else if (typeof prop.value.value === 'boolean') {
            checked = prop.value.value.toString();
          } else {
            checked = 'false';
          }
          break;
        case 'expanded':
          if (typeof prop.value.value === 'boolean') {
            expanded = prop.value.value;
          }
          break;
        case 'selected':
          if (typeof prop.value.value === 'boolean') {
            selected = prop.value.value;
          }
          break;
        case 'disabled':
          if (typeof prop.value.value === 'boolean') {
            disabled = prop.value.value;
          }
          break;
        case 'required':
          if (typeof prop.value.value === 'boolean') {
            required = prop.value.value;
          }
          break;
      }
    }
  }

  return [level, checked, expanded, selected, disabled, required];
}

function collectBackendNodeIds(node: any, ids: Set<number>): void {
  if (node.backendNodeId && typeof node.backendNodeId === 'number') {
    ids.add(node.backendNodeId);
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectBackendNodeIds(child, ids);
    }
  }

  if (node.shadowRoots && Array.isArray(node.shadowRoots)) {
    for (const child of node.shadowRoots) {
      collectBackendNodeIds(child, ids);
    }
  }

  if (node.contentDocument) {
    collectBackendNodeIds(node.contentDocument, ids);
  }
}

async function resolveSelectorBackendIds(
  client: CdpClient,
  sessionId: string,
  selector: string
): Promise<Set<number>> {
  const evalResult = await client.sendCommand(
    'Runtime.evaluate',
    {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
      awaitPromise: false,
    },
    sessionId
  );

  const objectId = (evalResult as any)?.result?.objectId;
  if (!objectId) {
    throw new Error(`Selector '${selector}' did not match any element`);
  }

  const describe = await client.sendCommand(
    'DOM.describeNode',
    { objectId, depth: -1 },
    sessionId
  );
  const rootNode = (describe as any)?.node;
  if (!rootNode) {
    throw new Error(`Could not resolve DOM node for selector '${selector}'`);
  }

  const ids = new Set<number>();
  collectBackendNodeIds(rootNode, ids);
  if (ids.size === 0) {
    throw new Error(`Could not resolve backendNodeId for selector '${selector}'`);
  }
  return ids;
}

function findEffectiveRoots(
  treeNodes: TreeNode[],
  selectorBackendIds: Set<number>,
  selector: string
): number[] {
  const inSubtree = treeNodes.map(
    (node) => node.backendNodeId !== undefined && selectorBackendIds.has(node.backendNodeId)
  );

  const roots: number[] = [];
  for (let idx = 0; idx < treeNodes.length; idx++) {
    if (!inSubtree[idx]) {
      continue;
    }
    const parentIdx = treeNodes[idx].parentIdx;
    const parentInSubtree = parentIdx !== undefined ? inSubtree[parentIdx] : false;
    if (!parentInSubtree) {
      roots.push(idx);
    }
  }

  if (roots.length === 0) {
    throw new Error(`No accessibility node found for selector '${selector}'`);
  }

  return roots;
}

function createEmptyNode(): TreeNode {
  return {
    role: '',
    name: '',
    children: [],
    hasRef: false,
    depth: 0,
  };
}

function clearNode(node: TreeNode): void {
  node.role = '';
  node.name = '';
  node.children = [];
  node.hasRef = false;
  node.refId = undefined;
  node.cursorInfo = undefined;
  node.url = undefined;
}
