/** Lists and launches apps on the desktop; depends on OrbitSession and Zod; never retries a launch and never sends paths or arguments. */
import { InvalidDesktopReply } from './agent.js';
import { MAX_APPS, appIconResultSchema, appPageSchema, launchResultSchema, type AppEntry } from './protocol.js';
import { CommandError, NotSent, type OrbitSession } from './session.js';

const LAUNCHER_TIMEOUT_MS = 20_000; // discovery and activation each use a bounded native helper on the desktop

export class LauncherApi {
  private revision?: string;
  private apps: AppEntry[] = [];
  private readonly icons = new Map<string, string | null>();
  constructor(private readonly session: OrbitSession) {
    session.onStatus(() => { this.revision = undefined; this.apps = []; this.icons.clear(); });
  }

  /** The app's own icon as base64 PNG, or null when the desktop has none. Cached per connection. */
  async icon(appId: string): Promise<string | null> {
    if (this.icons.has(appId)) return this.icons.get(appId)!;
    if (!this.revision || !this.apps.some(app => app.appId === appId)) throw new NotSent('Refresh the app list first');
    const result: unknown = await this.session.command('launcher.icon', { appId, catalogRevision: this.revision }, { timeoutMs: LAUNCHER_TIMEOUT_MS });
    const parsed = appIconResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.icons.set(appId, parsed.data.icon);
    return parsed.data.icon;
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
