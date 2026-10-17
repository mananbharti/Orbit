/** Routes App Launcher catalog and activation requests; depends on authenticated contexts and a native adapter; owns no windows, scenes or process lifecycle. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { AppLauncherAdapter, NativeApp } from '../os-integration/app-launcher.js';
import { ProtocolError } from '../protocol/errors.js';
import { APP_PAGE_SIZE, MAX_APPS, appIconSchema, appIconsSchema, appNameSchema, listAppsSchema, launchAppSchema, pinAppSchema, reorderAppsSchema, saveSceneSchema, sceneIdPayloadSchema } from '../protocol/app-launcher.js';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import type { LauncherLayout } from './launcher-layout.js';
import type { LauncherScenes } from './launcher-scenes.js';

/** App ids must stay stable across restarts or pinned favourites would dangle: the HMAC secret lives next to the other private state. */
function loadOrCreateSecret(path?: string): Buffer {
  if (path) {
    if (existsSync(path)) {
      const stored = readFileSync(path, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(stored)) return Buffer.from(stored, 'hex');
    }
    const secret = randomBytes(32);
    atomicWrite(path, secret.toString('hex'));
    return secret;
  }
  return randomBytes(32);
}

export class AppLauncher {
  private readonly secret: Buffer;
  private readonly abort = new AbortController();
  private readonly unregister: (() => void)[];
  private readonly jobs = new Set<Promise<unknown>>();
  private catalog = new Map<string, NativeApp>();
  private revision = randomUUID() as string;
  private busy = false;
  private adapter?: AppLauncherAdapter;

  constructor(registry: CommandRegistry, private readonly createAdapter: () => AppLauncherAdapter,
    private readonly layout?: LauncherLayout, secretPath?: string, private readonly scenes?: LauncherScenes) {
    this.secret = loadOrCreateSecret(secretPath);
    this.unregister = [
      registry.register('launcher.list', { validate: payload => listAppsSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async signal => {
          const { cursor } = listAppsSchema.parse(payload);
          let start = 0;
          if (cursor) {
            const [revision, index] = cursor.split(':');
            start = Number(index);
            if (revision !== this.revision || !start || start % APP_PAGE_SIZE !== 0 || start >= this.catalog.size) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
          } else await this.refresh(signal);
          this.authorize(context);
          const apps = [...this.catalog].slice(start, start + APP_PAGE_SIZE).map(([appId, app]) => ({ appId, name: app.name }));
          return { catalogRevision: this.revision, apps, pinned: this.layout?.list() ?? [],
            nextCursor: start + apps.length < this.catalog.size ? `${this.revision}:${start + apps.length}` : null };
        }) }),
      registry.register('launcher.icon', { validate: payload => appIconSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async signal => {
          const { appId, catalogRevision } = appIconSchema.parse(payload);
          if (catalogRevision !== this.revision) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
          const app = this.catalog.get(appId);
          if (!app) throw new ProtocolError('LAUNCHER_NOT_FOUND');
          this.authorize(context);
          const icon = this.adapter?.icon ? await this.adapter.icon(app, signal) : null;
          return { icon };
        }) }),
      registry.register('launcher.icons', { validate: payload => appIconsSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async signal => {
          const { appIds, catalogRevision } = appIconsSchema.parse(payload);
          if (catalogRevision !== this.revision) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
          this.authorize(context);
          // Stay well under the 64KB message cap: unknown apps are omitted and the response stops growing past ~48KB; the phone asks again for whatever is missing.
          const icons: Record<string, string | null> = {}; let bytes = 0;
          for (const appId of appIds) {
            const app = this.catalog.get(appId);
            if (!app) continue;
            const icon = this.adapter?.icon ? await this.adapter.icon(app, signal).catch(() => null) : null;
            if (bytes + (icon?.length ?? 0) > 48_000) break;
            icons[appId] = icon; bytes += icon?.length ?? 0;
          }
          return { icons };
        }) }),
      registry.register('launcher.launch', { validate: payload => launchAppSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async signal => {
          const { appId, catalogRevision } = launchAppSchema.parse(payload);
          if (catalogRevision !== this.revision) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
          await this.refresh(signal);
          if (catalogRevision !== this.revision) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
          const app = this.catalog.get(appId);
          if (!app) throw new ProtocolError('LAUNCHER_NOT_FOUND');
          this.authorize(context);
          await this.adapter!.launch(app, () => this.authorize(context), signal);
          return { status: 'requested' };
        }) }),
      registry.register('launcher.pin', { validate: payload => pinAppSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async () => {
          if (!this.layout) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          const { appId } = pinAppSchema.parse(payload);
          this.authorize(context);
          if (!this.catalog.has(appId)) throw new ProtocolError('LAUNCHER_NOT_FOUND');
          try { return { pinned: this.layout.pin(appId) }; }
          catch { throw new ProtocolError('LAUNCHER_LIMIT'); }
        }) }),
      registry.register('launcher.unpin', { validate: payload => pinAppSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async () => {
          if (!this.layout) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          const { appId } = pinAppSchema.parse(payload);
          this.authorize(context);
          return { pinned: this.layout.unpin(appId) };
        }) }),
      registry.register('launcher.reorder', { validate: payload => reorderAppsSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async () => {
          if (!this.layout) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          const { appIds } = reorderAppsSchema.parse(payload);
          this.authorize(context);
          try { return { pinned: this.layout.reorder(appIds) }; }
          catch { throw new ProtocolError('LAUNCHER_STALE_LAYOUT'); }
        }) }),
      registry.register('launcher.scenes', { validate: payload => payload === null || (typeof payload === 'object' && Object.keys(payload).length === 0),
        execute: (_payload, context) => this.run(context, async () => {
          if (!this.scenes) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          this.authorize(context);
          return { scenes: this.scenes.list() };
        }) }),
      registry.register('launcher.scene.save', { validate: payload => saveSceneSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async signal => {
          if (!this.scenes) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          const { id, name, appIds } = saveSceneSchema.parse(payload);
          this.authorize(context);
          if (!this.catalog.size) await this.refresh(signal); // a freshly restarted service has not listed yet
          for (const appId of appIds) if (!this.catalog.has(appId)) throw new ProtocolError('LAUNCHER_NOT_FOUND');
          try { return { scenes: this.scenes.save(name, appIds, id) }; }
          catch (error) {
            const message = (error as Error).message;
            if (message === 'LAUNCHER_SCENE_NAME_TAKEN') throw new ProtocolError('LAUNCHER_SCENE_CONFLICT');
            if (message === 'LAUNCHER_SCENE_NOT_FOUND') throw new ProtocolError('LAUNCHER_NOT_FOUND');
            throw new ProtocolError('LAUNCHER_LIMIT');
          }
        }) }),
      registry.register('launcher.scene.delete', { validate: payload => sceneIdPayloadSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async () => {
          if (!this.scenes) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          const { id } = sceneIdPayloadSchema.parse(payload);
          this.authorize(context);
          return { scenes: this.scenes.remove(id) };
        }) }),
      // Launching a scene activates each app in order; one failing app never blocks the rest, and the names of failures come back so the phone can say what did not open.
      registry.register('launcher.scene.launch', { validate: payload => sceneIdPayloadSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(context, async signal => {
          if (!this.scenes) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
          const { id } = sceneIdPayloadSchema.parse(payload);
          this.authorize(context);
          const scene = this.scenes.get(id);
          if (!scene) throw new ProtocolError('LAUNCHER_NOT_FOUND');
          await this.refresh(signal);
          const failed: string[] = []; let launched = 0;
          for (const appId of scene.appIds) {
            const app = this.catalog.get(appId);
            if (!app) { failed.push('(removed app)'); continue; }
            try { await this.adapter!.launch(app, () => this.authorize(context), signal); launched++; }
            catch { failed.push(app.name); }
          }
          return { launched, failed };
        }) }),
    ];
  }
  async stop(): Promise<void> {
    this.abort.abort();
    for (const unregister of this.unregister) unregister();
    await Promise.allSettled(this.jobs);
    this.catalog.clear();
  }
  private authorize(context: CommandContext): void {
    if (this.abort.signal.aborted || !context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
  }
  private run<T>(context: CommandContext, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.authorize(context);
    // Native discovery is bounded and shared across sockets; callers retry reads explicitly on BUSY.
    if (this.busy) return Promise.reject(new ProtocolError('BUSY'));
    this.busy = true;
    const signal = AbortSignal.any([this.abort.signal, context.connection!.closed]);
    const job = operation(signal).catch(error => {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError('LAUNCHER_UNAVAILABLE');
    }).finally(() => { this.busy = false; this.jobs.delete(job); });
    this.jobs.add(job);
    return job;
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    this.adapter ??= this.createAdapter();
    const entries = await this.adapter.list(signal);
    if (signal.aborted) throw new ProtocolError('UNAUTHENTICATED');
    if (entries.length > MAX_APPS) throw new ProtocolError('LAUNCHER_LIMIT');
    const next = new Map<string, NativeApp>();
    for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key))) {
      if (!appNameSchema.safeParse(entry.name).success) continue;
      const id = createHmac('sha256', this.secret).update(entry.key).digest('hex');
      if (next.has(id)) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
      next.set(id, entry);
    }
    if (JSON.stringify([...next]) !== JSON.stringify([...this.catalog])) this.revision = randomUUID();
    this.catalog = next;
  }
}
