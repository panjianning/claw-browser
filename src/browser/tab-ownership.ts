type BrowserAccessor = () => any | null;

type AcquireTabOptions = {
  preferredTabId?: string;
  createIfMissing?: boolean;
  initialUrl?: string;
};

type AcquireTabResult = {
  tabId: string;
  created: boolean;
};

type ReleaseOwnerOptions = {
  closeOwnedTabs?: boolean;
};

type TargetInfo = {
  targetId: string;
  type?: string;
  openerTargetId?: string;
};

type OwnershipRecord = {
  ownerId: string;
  createdByOwner: boolean;
  claimedAt: number;
};

export class TabOwnershipManager {
  private readonly ownership = new Map<string, OwnershipRecord>();
  private readonly ownerRoots = new Map<string, string>();
  private readonly ownerHeartbeats = new Map<string, number>();

  constructor(private readonly getBrowser: BrowserAccessor) {}

  touchOwner(ownerId: string): void {
    const normalized = ownerId.trim();
    if (!normalized) return;
    this.ownerHeartbeats.set(normalized, Date.now());
  }

  ownerHeartbeat(ownerId: string): number | null {
    const ts = this.ownerHeartbeats.get(ownerId.trim());
    return typeof ts === 'number' ? ts : null;
  }

  ownerOf(tabId: string): string | null {
    const rec = this.ownership.get(tabId.trim());
    return rec?.ownerId || null;
  }

  isOwnedBy(ownerId: string, tabId: string): boolean {
    const rec = this.ownership.get(tabId.trim());
    return rec?.ownerId === ownerId.trim();
  }

  getOwnerRootTab(ownerId: string): string | null {
    const normalized = ownerId.trim();
    if (!normalized) return null;
    const preferred = this.ownerRoots.get(normalized);
    if (preferred && this.ownership.get(preferred)?.ownerId === normalized) {
      return preferred;
    }

    for (const [tabId, rec] of this.ownership.entries()) {
      if (rec.ownerId === normalized) {
        this.ownerRoots.set(normalized, tabId);
        return tabId;
      }
    }
    return null;
  }

  async syncWithBrowser(): Promise<void> {
    const browser = this.getBrowser();
    if (!browser) {
      this.ownership.clear();
      this.ownerRoots.clear();
      return;
    }

    if (typeof browser.syncTrackedTabs === 'function') {
      try {
        await browser.syncTrackedTabs();
      } catch {
        // Ignore provider limitations (for example direct page session proxies).
      }
    }

    const pages = Array.isArray(browser.getPages?.()) ? browser.getPages() : [];
    const existingTabs = new Set(
      pages
        .map((p: any) => (typeof p?.targetId === 'string' ? p.targetId : ''))
        .filter((id: string) => id.length > 0)
    );

    for (const tabId of this.ownership.keys()) {
      if (!existingTabs.has(tabId)) {
        this.ownership.delete(tabId);
      }
    }

    for (const [ownerId, rootTabId] of this.ownerRoots.entries()) {
      if (!this.isOwnedBy(ownerId, rootTabId)) {
        this.ownerRoots.delete(ownerId);
      }
    }

    // Best effort opener inheritance for tabs created by window.open / target=_blank.
    const targetInfos = await this.getTargetInfos();
    for (const target of targetInfos) {
      if (target.type !== 'page' && target.type !== 'webview') continue;
      const tabId = String(target.targetId || '').trim();
      if (!tabId || this.ownership.has(tabId)) continue;

      const openerId = String(target.openerTargetId || '').trim();
      if (!openerId) continue;
      const openerOwner = this.ownership.get(openerId)?.ownerId;
      if (!openerOwner) continue;

      this.bindTabToOwner(tabId, openerOwner, { createdByOwner: true });
    }
  }

  async acquireTabForOwner(ownerIdInput: string, options: AcquireTabOptions = {}): Promise<AcquireTabResult> {
    const ownerId = ownerIdInput.trim();
    if (!ownerId) throw new Error('Missing ownerId');

    const browser = this.getBrowser();
    if (!browser) throw new Error('Browser not launched');

    await this.syncWithBrowser();

    const preferredTabId = String(options.preferredTabId || '').trim();
    if (preferredTabId) {
      const owner = this.ownerOf(preferredTabId);
      if (owner && owner !== ownerId) {
        throw new Error(`Tab ${preferredTabId} is owned by another run (${owner})`);
      }
      this.bindTabToOwner(preferredTabId, ownerId, { createdByOwner: false });
      this.touchOwner(ownerId);
      return { tabId: preferredTabId, created: false };
    }

    const currentRoot = this.getOwnerRootTab(ownerId);
    if (currentRoot) {
      this.touchOwner(ownerId);
      return { tabId: currentRoot, created: false };
    }

    const pages = Array.isArray(browser.getPages?.()) ? browser.getPages() : [];
    for (const page of pages) {
      const tabId = typeof page?.targetId === 'string' ? page.targetId : '';
      if (!tabId) continue;
      if (!this.ownerOf(tabId)) {
        this.bindTabToOwner(tabId, ownerId, { createdByOwner: false });
        this.touchOwner(ownerId);
        return { tabId, created: false };
      }
    }

    if (options.createIfMissing === false) {
      throw new Error(`No unowned tabs available for run ${ownerId}`);
    }

    const created = await browser.createNewPage();
    const tabId = String(created?.targetId || '').trim();
    if (!tabId) {
      throw new Error('Failed to create tab for owner');
    }

    this.bindTabToOwner(tabId, ownerId, { createdByOwner: true });
    if (typeof options.initialUrl === 'string' && options.initialUrl.trim().length > 0) {
      try {
        const pages = Array.isArray(browser.getPages?.()) ? browser.getPages() : [];
        const page = pages.find((p: any) => p?.targetId === tabId);
        if (page?.sessionId) {
          await browser.navigate(options.initialUrl.trim(), undefined, page.sessionId);
        }
      } catch {
        // Keep ownership even if eager navigate fails.
      }
    }
    this.touchOwner(ownerId);
    return { tabId, created: true };
  }

  async enforceTabOwnership(ownerIdInput: string, tabIdInput: string): Promise<void> {
    const ownerId = ownerIdInput.trim();
    const tabId = tabIdInput.trim();
    if (!ownerId || !tabId) throw new Error('Missing ownerId/tabId');

    await this.syncWithBrowser();
    const currentOwner = this.ownerOf(tabId);
    if (currentOwner && currentOwner !== ownerId) {
      throw new Error(`Tab ${tabId} is owned by another run (${currentOwner})`);
    }

    if (!currentOwner) {
      this.bindTabToOwner(tabId, ownerId, { createdByOwner: false });
    }
    this.touchOwner(ownerId);
  }

  bindTabToOwner(tabIdInput: string, ownerIdInput: string, options?: { createdByOwner?: boolean }): void {
    const tabId = tabIdInput.trim();
    const ownerId = ownerIdInput.trim();
    if (!tabId || !ownerId) return;

    const prev = this.ownership.get(tabId);
    this.ownership.set(tabId, {
      ownerId,
      createdByOwner: options?.createdByOwner === true ? true : (prev?.createdByOwner || false),
      claimedAt: Date.now(),
    });
    if (!this.ownerRoots.has(ownerId)) {
      this.ownerRoots.set(ownerId, tabId);
    }
    this.touchOwner(ownerId);
  }

  async releaseOwner(ownerIdInput: string, options: ReleaseOwnerOptions = {}): Promise<void> {
    const ownerId = ownerIdInput.trim();
    if (!ownerId) return;

    await this.syncWithBrowser();
    const browser = this.getBrowser();

    for (const [tabId, rec] of [...this.ownership.entries()]) {
      if (rec.ownerId !== ownerId) continue;

      if (options.closeOwnedTabs === true && rec.createdByOwner && browser?.closePage) {
        try {
          await browser.closePage(tabId);
        } catch {
          // Ignore close errors on tab teardown.
        }
      }
      this.ownership.delete(tabId);
    }

    this.ownerRoots.delete(ownerId);
    this.ownerHeartbeats.delete(ownerId);
  }

  snapshot(): Array<{ tabId: string; ownerId: string; createdByOwner: boolean; claimedAt: number }> {
    return [...this.ownership.entries()].map(([tabId, rec]) => ({
      tabId,
      ownerId: rec.ownerId,
      createdByOwner: rec.createdByOwner,
      claimedAt: rec.claimedAt,
    }));
  }

  private async getTargetInfos(): Promise<TargetInfo[]> {
    const browser = this.getBrowser();
    if (!browser?.client) return [];

    try {
      const result = await browser.client.sendCommand('Target.getTargets', {});
      const infos = Array.isArray((result as any)?.targetInfos)
        ? ((result as any).targetInfos as TargetInfo[])
        : [];
      return infos;
    } catch {
      return [];
    }
  }
}
