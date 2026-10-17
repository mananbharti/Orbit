/** Sorts received files into type folders (Documents, Images, ...); depends on Node filesystem; never overwrites an existing file. */
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const FOLDERS: [string, string[]][] = [
  ['Images', ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.svg', '.ico']],
  ['Videos', ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']],
  ['Audio', ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus']],
  ['Documents', ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt']],
  ['Archives', ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2']],
  ['Apps', ['.exe', '.msi', '.dmg', '.apk', '.ipa', '.deb', '.appimage']],
];

export function typeFolder(name: string): string {
  const ext = extname(name).toLowerCase();
  for (const [folder, extensions] of FOLDERS) if (extensions.includes(ext)) return folder;
  return 'Other';
}

/** inbox/<Type>/<name>, or "<name> (2)" onward when that name is taken. The check is advisory: linkSync is the real guard. */
export function organizedDestination(inbox: string, name: string): string {
  const folder = join(inbox, typeFolder(name));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = join(folder, attempt === 0 ? name : `${base} (${attempt + 1})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(folder, `${base}-${Date.now()}${ext}`);
}
