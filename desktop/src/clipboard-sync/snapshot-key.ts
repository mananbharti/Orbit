/** Fingerprints only the current clipboard value for echo suppression; depends on crypto; stores no text or history and never exports hashes. */
import { createHmac, randomBytes } from 'node:crypto';
import type { ClipboardSnapshot } from '../protocol/clipboard.js';

export function snapshotKey(): (snapshot: ClipboardSnapshot) => string {
  const key = randomBytes(32);
  return snapshot => createHmac('sha256', key).update(snapshot.kind).update('\0')
    .update(snapshot.kind === 'text' ? snapshot.text : '').digest('hex');
}
