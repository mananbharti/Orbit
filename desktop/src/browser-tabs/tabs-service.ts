/** Phone-facing browser tab commands; relays to the browser extension over the loopback channel. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import { ProtocolError } from '../protocol/errors.js';
import { openTabSchema, tabIdSchema, tabListSchema } from '../protocol/tabs.js';
import type { ExtensionServer } from './extension-server.js';

// The 'tabs' family is deliberately absent from FAMILY_SCOPE: tab titles and URLs are private, so only full-access devices may read or control them.
// Failure honesty: only a transport-level failure means the extension is offline; an extension that answered gets its real outcome.
const TRANSPORT_FAILURES = new Set(['extension not connected', 'timeout', 'shutdown']);
function tabsError(error: string | undefined): ProtocolError {
  if (error === 'not found') return new ProtocolError('TABS_NOT_FOUND');
  if (error && TRANSPORT_FAILURES.has(error)) return new ProtocolError('TABS_EXTENSION_OFFLINE');
  return new ProtocolError('TABS_ACTION_FAILED');
}
export class TabsService {
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, private readonly server: ExtensionServer) {
    this.unregister = [
      registry.register('tabs.status', { validate: p => p === null || (typeof p === 'object' && Object.keys(p).length === 0),
        execute: async () => ({ connected: this.server.extensionConnected }) }),
      registry.register('tabs.list', { validate: p => p === null || (typeof p === 'object' && Object.keys(p).length === 0),
        execute: async () => {
          const response = await this.server.request('list');
          if (!response.ok) throw new ProtocolError('TABS_EXTENSION_OFFLINE');
          const parsed = tabListSchema.safeParse(response.result);
          if (!parsed.success) throw new ProtocolError('TABS_EXTENSION_OFFLINE');
          return { connected: true, ...parsed.data };
        } }),
      registry.register('tabs.open', { validate: p => openTabSchema.safeParse(p).success,
        execute: async p => {
          const { url } = openTabSchema.parse(p);
          const response = await this.server.request('open', { url });
          if (!response.ok) throw tabsError(response.error);
          return { opened: true };
        } }),
      registry.register('tabs.close', { validate: p => tabIdSchema.safeParse(p).success,
        execute: async p => {
          const { tabId } = tabIdSchema.parse(p);
          const response = await this.server.request('close', { tabId });
          if (!response.ok) throw tabsError(response.error);
          return { closed: true };
        } }),
      registry.register('tabs.activate', { validate: p => tabIdSchema.safeParse(p).success,
        execute: async p => {
          const { tabId } = tabIdSchema.parse(p);
          const response = await this.server.request('activate', { tabId });
          if (!response.ok) throw tabsError(response.error);
          return { activated: true };
        } }),
    ];
  }

  async stop(): Promise<void> { for (const unregister of this.unregister) unregister(); }
}
