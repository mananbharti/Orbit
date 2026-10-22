/** Pure photo-backup cursor, selection and failure tracking, per computer; depends on Zod only, so the app layer stays thin glue over the camera roll. */
import { z } from 'zod';

export interface PhotoRef { id: string; creationTime: number }
/** time: newest backed-up creationTime (ms). ids: photos already done at exactly that time (same-second photos). failed: ids to retry next pass. */
export interface BackupCursor { time: number; ids: string[]; failed: string[] }

export const MAX_FAILED_PHOTOS = 50;
export const MAX_BOUNDARY_IDS = 64;

export function emptyCursor(): BackupCursor { return { time: 0, ids: [], failed: [] }; }

/** Photos still to upload from an ascending-by-creationTime page: strictly newer, or at the cursor time but not done yet. */
export function selectNewPhotos(assets: PhotoRef[], cursor: BackupCursor): PhotoRef[] {
  const done = new Set(cursor.ids);
  return assets.filter(a => a.creationTime > cursor.time || (a.creationTime === cursor.time && !done.has(a.id)));
}

/** Advances after a successful upload. A retried older failure moves neither the time nor the boundary. */
export function advanceCursor(cursor: BackupCursor, photo: PhotoRef): BackupCursor {
  const failed = cursor.failed.filter(id => id !== photo.id);
  if (photo.creationTime > cursor.time) return { time: photo.creationTime, ids: [photo.id], failed };
  if (photo.creationTime === cursor.time) return { time: cursor.time, ids: [...cursor.ids.filter(id => id !== photo.id).slice(-(MAX_BOUNDARY_IDS - 1)), photo.id], failed };
  return { time: cursor.time, ids: cursor.ids, failed };
}

/** Records a failed photo (newest first, bounded); the cursor itself never moves on failure. */
export function recordFailure(cursor: BackupCursor, photo: PhotoRef): BackupCursor {
  return { ...cursor, failed: [photo.id, ...cursor.failed.filter(id => id !== photo.id)].slice(0, MAX_FAILED_PHOTOS) };
}

/** Drops a failed id whose photo is gone from the library. */
export function forgetFailure(cursor: BackupCursor, id: string): BackupCursor {
  return { ...cursor, failed: cursor.failed.filter(f => f !== id) };
}

const cursorSchema = z.strictObject({ time: z.number().int().nonnegative(),
  ids: z.array(z.string().min(1).max(256)).max(MAX_BOUNDARY_IDS),
  failed: z.array(z.string().min(1).max(256)).max(MAX_FAILED_PHOTOS) });
const storedSchema = z.strictObject({ enabled: z.boolean(),
  cursors: z.record(z.string(), z.union([cursorSchema, z.number().int().nonnegative()])) });

export interface BackupState { enabled: boolean; cursors: Record<string, BackupCursor> }

/** Parses the persisted state, upgrading the original number-only cursors; anything unreadable starts clean. */
export function migrateBackupState(raw: string | null | undefined): BackupState {
  if (!raw) return { enabled: false, cursors: {} };
  try {
    const stored = storedSchema.parse(JSON.parse(raw));
    const cursors: Record<string, BackupCursor> = {};
    for (const [desktop, cursor] of Object.entries(stored.cursors)) {
      cursors[desktop] = typeof cursor === 'number' ? { time: cursor, ids: [], failed: [] } : cursor;
    }
    return { enabled: stored.enabled, cursors };
  } catch { return { enabled: false, cursors: {} }; }
}
