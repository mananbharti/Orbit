/** Pure helpers for files shared into Orbit from other apps (iOS "Open in..." delivers a file:// URL). */

/** True when a launch/link URL carries a shared local file rather than an app deep link. */
export function isSharedFileUrl(url: string): boolean {
  return url.startsWith('file://');
}

/** Best-effort file name for a shared-file URL: last path segment, percent-decoded, falling back to a timestamped name. */
export function sharedFileName(url: string, now = Date.now()): string {
  try {
    const path = url.replace(/^file:\/\//, '').split(/[?#]/)[0] ?? '';
    const segment = path.split('/').filter(Boolean).pop();
    const decoded = segment ? decodeURIComponent(segment) : '';
    const clean = decoded.replace(/[/\\:*?"<>|]/g, '').trim();
    if (clean && clean !== '.' && clean !== '..') return clean;
  } catch { /* fall through to the default name */ }
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `Shared file ${stamp}`;
}
