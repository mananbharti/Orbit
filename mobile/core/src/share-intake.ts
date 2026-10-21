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
    const clean = fitFileName(decoded.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, '').trim());
    if (clean) return clean;
  } catch { /* fall through to the default name */ }
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `Shared file ${stamp}`;
}

/** Makes a name the desktop accepts: no trailing dot or space, no Windows device names, at most 200 UTF-8 bytes (extension kept). Empty when nothing usable is left. */
function fitFileName(name: string): string {
  let out = name.replace(/[. ]+$/, '');
  if (!out || /^\.+$/.test(out)) return '';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = `_${out}`;
  const bytes = (v: string): number => new TextEncoder().encode(v).length;
  if (bytes(out) > 200) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : '';
    let stem = [...out.slice(0, ext ? dot : undefined)];
    while (stem.length && bytes(stem.join('') + ext) > 200) stem.pop();
    out = (stem.join('') + ext).replace(/[. ]+$/, '');
  }
  return out;
}
