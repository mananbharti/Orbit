/** Phone-facing browser tab commands; relays to the browser extension over the loopback channel. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import { ProtocolError } from '../protocol/errors.js';
import { openTabSchema, tabIdSchema, tabListSchema } from '../protocol/tabs.js';
import type { ExtensionServer } from './extension-server.js';

// The 'tabs' family is deliberately absent from FAMILY_SCOPE: tab titles and URLs are private, so only full-access devices may read or control them.
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
          if (!response.ok) throw new ProtocolError('TABS_EXTENSION_OFFLINE');
          return { opened: true };
        } }),
      registry.register('tabs.close', { validate: p => tabIdSchema.safeParse(p).success,
        execute: async p => {
          const { tabId } = tabIdSchema.parse(p);
          const response = await this.server.request('close', { tabId });
          if (!response.ok) throw new ProtocolError(response.error === 'not found' ? 'TABS_NOT_FOUND' : 'TABS_EXTENSION_OFFLINE');
          return { closed: true };
        } }),
      registry.register('tabs.activate', { validate: p => tabIdSchema.safeParse(p).success,
        execute: async p => {
          const { tabId } = tabIdSchema.parse(p);
          const response = await this.server.request('activate', { tabId });
          if (!response.ok) throw new ProtocolError(response.error === 'not found' ? 'TABS_NOT_FOUND' : 'TABS_EXTENSION_OFFLINE');
          return { activated: true };
        } }),
    ];
  }

  async stop(): Promise<void> { for (const unregister of this.unregister) unregister(); }
}
