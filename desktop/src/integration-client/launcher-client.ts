/** Lists and activates apps through the paired channel; depends on strict protocol schemas; never retries launches or supplies paths and arguments. */
import { appPageSchema, launchAppSchema, launchResultSchema, MAX_APPS, type AppPage } from '../protocol/app-launcher.js';
import { ProtocolError } from '../protocol/errors.js';
import type { OrbitClient } from './orbit-client.js';

export class LauncherClient {
  private revision?: string;
  private apps: AppPage['apps'] = [];
  private epoch = 0;
  private stopped = false;
  private readonly reset = () => { this.revision = undefined; this.apps = []; this.epoch++; };
  constructor(private readonly client: OrbitClient) { client.on('status', this.reset); }
  async list(): Promise<AppPage['apps']> {
    this.reset();
    const epoch = this.epoch;
    let cursor: string | null = null;
    let revision: string | undefined;
    const apps: AppPage['apps'] = [];
    const cursors = new Set<string>();
    do {
      const response = await this.client.scheduledCommand('launcher.list', cursor ? { cursor } : {});
      if (this.stopped || epoch !== this.epoch) throw new Error('Connection changed; list again');
      if (!response.payload.ok) throw new ProtocolError(response.payload.error.code);
      const page = appPageSchema.parse(response.payload.result);
      if (revision && page.catalogRevision !== revision) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
      revision = page.catalogRevision;
      apps.push(...page.apps);
      if (apps.length > MAX_APPS || (page.nextCursor && cursors.has(page.nextCursor))) throw new ProtocolError('LAUNCHER_LIMIT');
      cursor = page.nextCursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.revision = revision; this.apps = apps;
    return apps.map(app => ({ ...app }));
  }
  async launch(appId: string): Promise<void> {
    if (this.stopped || !this.revision || !this.apps.some(app => app.appId === appId)) throw new ProtocolError('LAUNCHER_NOT_FOUND');
    const payload = launchAppSchema.parse({ appId, catalogRevision: this.revision });
    const response = await this.client.scheduledCommand('launcher.launch', payload);
    if (!response.payload.ok) {
      if (response.payload.error.code === 'LAUNCHER_STALE_CATALOG') this.reset();
      throw new ProtocolError(response.payload.error.code);
    }
    launchResultSchema.parse(response.payload.result);
  }
  stop(): void { this.stopped = true; this.reset(); this.client.off('status', this.reset); }
}
