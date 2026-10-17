import { isSharedFileUrl, sharedFileName, type FileApi } from '@orbit/core';
import { Platform } from 'react-native';
import { sourceFromUri } from './files';

type LinkingModule = typeof import('expo-linking');

let linking: LinkingModule | undefined;
try { if (Platform.OS !== 'web') linking = require('expo-linking') as LinkingModule; } catch { linking = undefined; }

export const shareIntakeAvailable = (): boolean => !!linking;

export type ShareIntakeEvents = {
  onQueued: (count: number) => void;
  onError: (message: string) => void;
};

/**
 * Receives files other apps share into Orbit (iOS "Open in..." delivers a file:// URL) and uploads
 * them to the connected computer. Shares that arrive while disconnected wait in memory until a
 * connection is up, then upload in order.
 */
export class ShareIntake {
  private pending: string[] = [];
  private uploading = false;
  private subscription?: { remove(): void };

  constructor(private readonly files: () => FileApi | undefined, private readonly events: ShareIntakeEvents) {}

  start(): void {
    if (!linking || this.subscription) return;
    void linking.getInitialURL().then(url => { if (url) this.accept(url); }).catch(() => undefined);
    this.subscription = linking.addEventListener('url', ({ url }) => this.accept(url));
  }

  stop(): void { this.subscription?.remove(); this.subscription = undefined; }

  /** Call when a computer connects so queued shares upload. */
  notifyConnected(): void { void this.drain(); }

  accept(url: string): void {
    if (!isSharedFileUrl(url)) return;
    this.pending.push(url);
    this.events.onQueued(this.pending.length);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.uploading) return;
    this.uploading = true;
    try {
      for (;;) {
        const api = this.files();
        const url = this.pending[0];
        if (!api || !url) break;
        try {
          await api.upload(sourceFromUri(url, sharedFileName(url)));
          this.pending.shift();
        } catch (e) {
          this.pending.shift(); // do not retry-loop a bad file; surface and move on
          this.events.onError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally { this.uploading = false; }
  }
}
