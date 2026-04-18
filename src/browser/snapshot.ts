import type { DaemonState } from './state.js';
import { takeSnapshot } from '../cdp/accessibility.js';

/**
 * Snapshot and screenshot action handlers
 */

export async function handleSnapshot(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  // Extract options
  const compact = cmd.compact === true;
  const maxDepth = cmd.maxDepth !== undefined ? Number(cmd.maxDepth) : undefined;
  const selector = cmd.selector;
  const interactive = cmd.interactive === true;

  try {
    state.refMap.clear();
    const tree = await takeSnapshot(
      mgr.client,
      sessionId,
      state.iframeSessions,
      {
        compact,
        depth: maxDepth,
        selector,
        interactive,
      }
    );

    // Build command ref map (e.g. @e12) for follow-up actions.
    const roleNameSeen = new Map<string, number>();
    for (const [refId, ref] of Object.entries(tree.refs || {})) {
      const role = typeof ref.role === 'string' ? ref.role : '';
      const name = typeof ref.name === 'string' ? ref.name : '';
      const key = `${role}\u0000${name}`;
      const nth = roleNameSeen.get(key) || 0;
      roleNameSeen.set(key, nth + 1);
      const entry = {
        role,
        name,
        nth,
        frameId: state.activeFrameId || null,
      };
      state.refMap.set(refId, entry);
      state.refMap.set(`@${refId}`, entry);
    }

    const url = await mgr.getUrl().catch(() => '');

    return {
      id,
      success: true,
      data: {
        snapshot: tree.tree,
        refs: tree.refs,
        url,
      },
    };
  } catch (error: any) {
    return {
      id,
      success: false,
      error: `Snapshot failed: ${error.message || String(error)}`,
    };
  }
}

export async function handleScreenshot(cmd: any, state: DaemonState): Promise<any> {
  const id = cmd.id || '';

  const mgr = state.browser;
  if (!mgr) {
    return { id, success: false, error: 'Browser not launched' };
  }

  const sessionId = mgr.activeSessionId?.() || '';

  // Extract options
  const path = cmd.path;
  const fullPage = cmd.fullPage === true;
  const selector = cmd.selector;
  const annotations = cmd.annotations; // Array of annotation objects

  try {
    // TODO: Full implementation from cli/src/native/screenshot.rs
    // For now, basic CDP screenshot
    const params: any = {
      format: 'png',
      captureBeyondViewport: fullPage,
    };

    if (selector) {
      // Clip to element bounding box
      const backendNodeId = state.refMap.get(selector);
      if (!backendNodeId) {
        return { id, success: false, error: `Element not found: ${selector}` };
      }

      const { nodeId } = await mgr.client.sendCommand(
        'DOM.resolveNode',
        { backendNodeId },
        sessionId
      );
      const { model } = await mgr.client.sendCommand(
        'DOM.getBoxModel',
        { nodeId },
        sessionId
      );

      const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
      params.clip = {
        x: x1,
        y: y1,
        width: x3 - x1,
        height: y3 - y1,
        scale: 1,
      };
    }

    const result = await mgr.client.sendCommand(
      'Page.captureScreenshot',
      params,
      sessionId
    );

    const base64Data = result.data;
    if (!base64Data) {
      return { id, success: false, error: 'No screenshot data returned' };
    }

    // Handle annotations (TODO: requires image library like sharp)
    let finalData = base64Data;
    if (annotations && annotations.length > 0) {
      // TODO: Draw annotations on screenshot using sharp or similar
      // For now, just return unmodified screenshot
      console.warn('Screenshot annotations not yet implemented');
    }

    // Save to file if path provided
    let savePath = path;
    if (!savePath) {
      // Generate default path
      const timestamp = Date.now();
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      savePath = `${homeDir}/.agent-browser/tmp/screenshots/screenshot-${timestamp}.png`;
    }

    // Ensure directory exists
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const dir = pathMod.dirname(savePath);
    await fs.mkdir(dir, { recursive: true });

    // Decode base64 and write file
    const buffer = Buffer.from(finalData, 'base64');
    await fs.writeFile(savePath, buffer);

    return {
      id,
      success: true,
      data: {
        path: savePath,
        base64: finalData,
      },
    };
  } catch (error: any) {
    return {
      id,
      success: false,
      error: `Screenshot failed: ${error.message || String(error)}`,
    };
  }
}
