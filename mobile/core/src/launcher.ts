/** Lists and launches apps on the desktop; depends on OrbitSession and Zod; never retries a launch and never sends paths or arguments. */
import { InvalidDesktopReply } from './agent.js';
import type { JsonValue } from './protocol.js';
import { ICON_BATCH_SIZE, MAX_APPS, appIconResultSchema, appIconsResultSchema, appPageSchema, launchResultSchema, launcherLayoutSchema, launcherScenesSchema, sceneLaunchResultSchema, type AppEntry, type LauncherScene } from './protocol.js';
import { CommandError, NotSent, type OrbitSession } from './session.js';

const LAUNCHER_TIMEOUT_MS = 20_000; // discovery and activation each use a bounded native helper on the desktop

export class LauncherApi {
  private revision?: string;
  private apps: AppEntry[] = [];
  private pinned: string[] = [];
  private readonly iconCache = new Map<string, string | null>();
  constructor(private readonly session: OrbitSession) {
    session.onStatus(() => { this.revision = undefined; this.apps = []; this.pinned = []; this.iconCache.clear(); });
  }

  /** Ordered pinned app ids, as of the last list()/pin()/unpin()/reorder(). */
  getPinned(): string[] { return [...this.pinned]; }

  private async layout(type: 'launcher.pin' | 'launcher.unpin' | 'launcher.reorder', payload: JsonValue): Promise<string[]> {
    const result: unknown = await this.session.command(type, payload, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = launcherLayoutSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.pinned = parsed.data.pinned;
    return this.getPinned();
  }
  /** Adds an app to the pinned favourites (no-op when already pinned). */
  async pin(appId: string): Promise<string[]> { return this.layout('launcher.pin', { appId }); }
  async unpin(appId: string): Promise<string[]> { return this.layout('launcher.unpin', { appId }); }
  /** New favourite order; the desktop rejects anything that is not a permutation of its current pins. */
  async reorder(pinned: string[]): Promise<string[]> { return this.layout('launcher.reorder', { appIds: pinned }); }

  /** Saved app groups, newest first, as stored on the desktop. */
  async scenes(): Promise<LauncherScene[]> {
    const result: unknown = await this.session.command('launcher.scenes', {}, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = launcherScenesSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.scenes;
  }
  /** Creates a scene (no id) or replaces it; every appId must exist in the desktop's catalog. */
  async saveScene(name: string, appIds: string[], id?: string): Promise<LauncherScene[]> {
    const result: unknown = await this.session.command('launcher.scene.save', { name, appIds, ...(id ? { id } : {}) }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = launcherScenesSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.scenes;
  }
  async deleteScene(id: string): Promise<LauncherScene[]> {
    const result: unknown = await this.session.command('launcher.scene.delete', { id }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = launcherScenesSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.scenes;
  }
  /** Launches every app in the scene; apps that fail come back by name, they never block the rest. */
  async launchScene(id: string): Promise<{ launched: number; failed: string[] }> {
    const result: unknown = await this.session.command('launcher.scene.launch', { id }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = sceneLaunchResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  /** The app's own icon as base64 PNG, or null when the desktop has none. Cached per connection. */
  async icon(appId: string): Promise<string | null> {
    if (this.iconCache.has(appId)) return this.iconCache.get(appId)!;
    if (!this.revision || !this.apps.some(app => app.appId === appId)) throw new NotSent('Refresh the app list first');
    const result: unknown = await this.session.command('launcher.icon', { appId, catalogRevision: this.revision }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = appIconResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.iconCache.set(appId, parsed.data.icon);
    return parsed.data.icon;
  }

  /** Fetches icons for several apps in one round trip (the desktop serializes native work, so batches are far faster than per-app calls). Unknown apps are cached as null; apps cut by the response byte budget simply stay uncached for the next call. */
  async icons(appIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    for (const appId of appIds) {
      if (this.iconCache.has(appId)) out.set(appId, this.iconCache.get(appId)!);
      else missing.push(appId);
    }
    if (!missing.length) return out;
    if (!this.revision) throw new NotSent('Refresh the app list first');
    const known = new Set(this.apps.map(app => app.appId));
    const request = missing.filter(appId => known.has(appId));
    for (const appId of missing) if (!known.has(appId)) { this.iconCache.set(appId, null); out.set(appId, null); }
    for (let i = 0; i < request.length; i += ICON_BATCH_SIZE) {
      const batch = request.slice(i, i + ICON_BATCH_SIZE);
      const result: unknown = await this.session.command('launcher.icons', { appIds: batch, catalogRevision: this.revision }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
      const parsed = appIconsResultSchema.safeParse(result);
      if (!parsed.success) throw new InvalidDesktopReply();
      for (const appId of batch) {
        if (!(appId in parsed.data.icons)) continue; // cut by the byte budget: try again next time
        const icon = parsed.data.icons[appId]!;
        this.iconCache.set(appId, icon); out.set(appId, icon);
      }
    }
    return out;
  }

  /** Fetches the whole catalog. A catalog that changes mid-listing fails with LAUNCHER_STALE_CATALOG; list again. */
  async list(): Promise<AppEntry[]> {
    this.revision = undefined; this.apps = [];
    let cursor: string | null = null;
    let revision: string | undefined;
    const apps: AppEntry[] = [];
    const seen = new Set<string>();
    do {
      const result: unknown = await this.session.command('launcher.list', cursor ? { cursor } : {}, { timeoutMs: LAUNCHER_TIMEOUT_MS });
      const parsed = appPageSchema.safeParse(result);
      if (!parsed.success) throw new InvalidDesktopReply();
      const page = parsed.data;
      if (revision && page.catalogRevision !== revision) throw new CommandError('LAUNCHER_STALE_CATALOG');
      revision = page.catalogRevision;
      this.pinned = page.pinned;
      apps.push(...page.apps);
      if (apps.length > MAX_APPS || (page.nextCursor && seen.has(page.nextCursor))) throw new CommandError('LAUNCHER_LIMIT');
      cursor = page.nextCursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    this.revision = revision; this.apps = apps;
    return apps.map(app => ({ ...app }));
  }

  /** Only apps from the latest list() can be launched. Rejects with OutcomeUnknown if the connection drops; do not blindly retry. */
  async launch(appId: string): Promise<void> {
    if (!this.revision || !this.apps.some(app => app.appId === appId)) throw new NotSent('Refresh the app list first');
    try {
      const result = await this.session.command('launcher.launch', { appId, catalogRevision: this.revision }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
      if (!launchResultSchema.safeParse(result).success) throw new InvalidDesktopReply();
    } catch (error) {
      if (error instanceof CommandError && error.code === 'LAUNCHER_STALE_CATALOG') { this.revision = undefined; this.apps = []; }
      throw error;
    }
  }
}
