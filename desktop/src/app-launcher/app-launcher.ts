/** Routes App Launcher catalog and activation requests; depends on authenticated contexts and a native adapter; owns no windows, scenes or process lifecycle. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { AppLauncherAdapter, NativeApp } from '../os-integration/app-launcher.js';
import { ProtocolError } from '../protocol/errors.js';
import { APP_PAGE_SIZE, MAX_APPS, appNameSchema, listAppsSchema, launchAppSchema } from '../protocol/app-launcher.js';

export class AppLauncher {
  private readonly secret = randomBytes(32);
  private readonly abort = new AbortController();
  private readonly unregister: (() => void)[];
  private readonly jobs = new Set<Promise<unknown>>();
  private catalog = new Map<string, NativeApp>();
  private revision = randomUUID() as string;
  private busy = false;
  private adapter?: AppLauncherAdapter;

  constructor(registry: CommandRegistry, private readonly createAdapter: () => AppLauncherAdapter) {
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
          return { catalogRevision: this.revision, apps,
            nextCursor: start + apps.length < this.catalog.size ? `${this.revision}:${start + apps.length}` : null };
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
