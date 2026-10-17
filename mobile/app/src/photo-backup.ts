/** Backs up new photos to the paired computer while Orbit is open; depends on expo-media-library (dynamic require + web guard) and the existing file transfer. */
import * as SecureStore from 'expo-secure-store';
import type { Connected } from './orbit';
import { sourceFromUri } from './files';

interface MediaAsset { id: string; uri: string; filename: string; creationTime: number }
interface MediaLibrary {
  requestPermissionsAsync(writeOnly?: boolean): Promise<{ status: string; canAskAgain: boolean }>;
  getAssetsAsync(options: { first: number; after?: string; sortBy: unknown; mediaType: unknown[]; createdAfter?: number }):
    Promise<{ assets: MediaAsset[]; endCursor: string; hasNextPage: boolean }>;
  getAssetInfoAsync(asset: MediaAsset): Promise<{ localUri?: string; uri: string; filename: string }>;
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
interface BackupState { enabled: boolean; cursors: Record<string, number> } // per computer: last backed-up creationTime (ms)
async function loadState(): Promise<BackupState> {
  try { const raw = await SecureStore.getItemAsync(KEY); if (raw) return JSON.parse(raw) as BackupState; } catch { /* fall through */ }
  return { enabled: false, cursors: {} };
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
      const state = await loadState();
      const desktop = this.connected.paired.desktopServiceId;
      const since = state.cursors[desktop] ?? 0;
      const photos: MediaAsset[] = [];
      let after: string | undefined;
      do {
        const page = await ml.getAssetsAsync({ first: 100, ...(after ? { after } : {}),
          sortBy: [['creationTime', true]], mediaType: [ml.MediaType.photo], ...(since ? { createdAfter: since } : {}) });
        photos.push(...page.assets);
        after = page.hasNextPage ? page.endCursor : undefined;
      } while (after && photos.length < 1_000 && !this.stopped);
      let newest = since;
      this.listener({ done: 0, total: photos.length, running: true });
      for (const [index, photo] of photos.entries()) {
        if (this.stopped) return;
        try {
          const info = await ml.getAssetInfoAsync(photo); // ph:// uris cannot be read directly; localUri is the on-disk file
          await this.connected.files.upload(sourceFromUri(info.localUri ?? info.uri, info.filename || photo.filename));
          newest = Math.max(newest, photo.creationTime);
        } catch { break; } // a failed photo retries next pass; do not advance the cursor past it
        const latest = await loadState();
        await saveState({ ...latest, cursors: { ...latest.cursors, [desktop]: newest } });
        this.listener({ done: index + 1, total: photos.length, running: true });
      }
      this.listener({ done: photos.length, total: photos.length, running: false });
    } finally { this.running = false; }
  }
}
