/** Backs up new photos to the paired computer while Orbit is open; depends on expo-media-library (dynamic require + web guard) and the existing file transfer. */
import * as SecureStore from 'expo-secure-store';
import { advanceCursor, emptyCursor, forgetFailure, migrateBackupState, recordFailure, selectNewPhotos,
  type BackupCursor, type BackupState, type PhotoRef } from '@orbit/core';
import type { Connected } from './orbit';
import { sourceFromUri } from './files';

interface MediaAsset { id: string; uri: string; filename: string; creationTime: number }
interface MediaLibrary {
  requestPermissionsAsync(writeOnly?: boolean): Promise<{ status: string; canAskAgain: boolean }>;
  getAssetsAsync(options: { first: number; after?: string; sortBy: unknown; mediaType: unknown[]; createdAfter?: number }):
    Promise<{ assets: MediaAsset[]; endCursor: string; hasNextPage: boolean }>;
  getAssetInfoAsync(asset: MediaAsset | string): Promise<{ localUri?: string; uri: string; filename: string; creationTime?: number }>;
  MediaType: { photo: string };
}

function mediaLibrary(): MediaLibrary | undefined {
  if (typeof window !== 'undefined') return undefined; // web preview has no camera roll
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-media-library') as MediaLibrary;
  } catch { return undefined; } // native module missing (web or old dev-client)
}

export function photoBackupAvailable(): boolean { return mediaLibrary() !== undefined; }
export async function photoBackupPermitted(): Promise<boolean> {
  const ml = mediaLibrary();
  if (!ml) return false;
  return (await ml.requestPermissionsAsync()).status === 'granted';
}

const KEY = 'orbit.photo-backup.v1';
async function loadState(): Promise<BackupState> {
  try { return migrateBackupState(await SecureStore.getItemAsync(KEY)); } catch { return { enabled: false, cursors: {} }; }
}
async function saveState(state: BackupState): Promise<void> {
  try { await SecureStore.setItemAsync(KEY, JSON.stringify(state)); } catch { /* cosmetic; ignore */ }
}
export async function photoBackupEnabled(): Promise<boolean> { return (await loadState()).enabled; }
export async function setPhotoBackupEnabled(on: boolean): Promise<void> {
  const state = await loadState();
  await saveState({ ...state, enabled: on });
}

export interface BackupProgress { done: number; total: number; running: boolean }
export type ProgressListener = (p: BackupProgress) => void;

/** Watches the camera roll while the app is open and sends each new photo through the normal file channel. iOS suspends us in the background; anything missed is caught on the next open. */
export class PhotoBackup {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  constructor(private readonly connected: Connected, private readonly listener: ProgressListener) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, 60_000);
    void this.pass();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async pass(): Promise<void> {
    if (this.running || this.stopped) return;
    const ml = mediaLibrary();
    if (!ml || !(await loadState()).enabled) return;
    if ((await ml.requestPermissionsAsync()).status !== 'granted') return;
    this.running = true;
    try {
      const desktop = this.connected.paired.desktopServiceId;
      let cursor: BackupCursor = (await loadState()).cursors[desktop] ?? emptyCursor();
      const save = async () => {
        const latest = await loadState();
        await saveState({ ...latest, cursors: { ...latest.cursors, [desktop]: cursor } });
      };
      // Uploads never move the cursor on failure; a failed photo joins the retry list instead of blocking newer ones.
      const uploadOne = async (photo: PhotoRef, info: { localUri?: string; uri: string; filename: string }, fallbackName: string) => {
        try {
          await this.connected.files.upload(sourceFromUri(info.localUri ?? info.uri, info.filename || fallbackName));
          cursor = advanceCursor(cursor, photo);
        } catch { cursor = recordFailure(cursor, photo); }
        await save();
      };
      // Retry earlier failures first; a photo deleted from the library is forgotten.
      for (const id of [...cursor.failed]) {
        if (this.stopped) return;
        let info;
        try { info = await ml.getAssetInfoAsync(id); }
        catch { cursor = forgetFailure(cursor, id); await save(); continue; }
        await uploadOne({ id, creationTime: info.creationTime ?? 0 }, info, 'photo.jpg');
      }
      // createdAfter is one ms behind the cursor so same-second photos appear whatever the platform's inclusivity; selectNewPhotos filters strictly.
      const photos: MediaAsset[] = [];
      let after: string | undefined;
      do {
        const page = await ml.getAssetsAsync({ first: 100, ...(after ? { after } : {}),
          sortBy: [['creationTime', true]], mediaType: [ml.MediaType.photo], ...(cursor.time ? { createdAfter: cursor.time - 1 } : {}) });
        photos.push(...page.assets);
        after = page.hasNextPage ? page.endCursor : undefined;
      } while (after && photos.length < 1_000 && !this.stopped);
      const queue = selectNewPhotos(photos, cursor);
      this.listener({ done: 0, total: queue.length, running: true });
      for (const [index, asset] of queue.entries()) {
        if (this.stopped) return;
        try {
          const info = await ml.getAssetInfoAsync(asset.id); // ph:// uris cannot be read directly; localUri is the on-disk file
          await uploadOne(asset, info, "photo.jpg");
        } catch { cursor = recordFailure(cursor, asset); await save(); }
        this.listener({ done: index + 1, total: queue.length, running: true });
      }
      this.listener({ done: queue.length, total: queue.length, running: false });
    } finally { this.running = false; }
  }
}
