/** Discovers visible XDG applications and delegates activation to GIO; depends on the graphical session and gio; never expands Exec strings or accepts remote paths. */
import { createHash } from 'node:crypto';
import { access, open, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ProtocolError } from '../protocol/errors.js';
import { MAX_APPS } from '../protocol/app-launcher.js';
import type { AppLauncherAdapter, NativeApp } from './app-launcher.js';
import { runLauncherTool, type LauncherTool } from './launcher-tool.js';

const MAX_ENTRY_BYTES = 64 * 1_024;
const MAX_SCAN_ITEMS = 8_192;
const MAX_DEPTH = 8;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const unescape = (value: string): string => value.replace(/\\([sntr\\;])/g, (_, key: string) =>
  ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\', ';': ';' })[key]!);
const values = (value = '') => (value.match(/(?:\\.|[^;])+/g) ?? []).map(unescape);

export function desktopEntry(text: string, env: NodeJS.ProcessEnv): { name: string; tryExec?: string } | undefined {
  const keys = new Map<string, string>();
  const groups = new Set<string>();
  let group = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      group = line.slice(1, -1);
      if (groups.has(group)) return;
      groups.add(group); continue;
    }
    if (group !== 'Desktop Entry') continue;
    const match = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/.exec(line);
    if (!match || keys.has(match[1]!)) return;
    keys.set(match[1]!, match[2]!);
  }
  for (const key of ['Hidden', 'NoDisplay', 'Terminal', 'DBusActivatable']) {
    if (keys.has(key) && !['true', 'false'].includes(keys.get(key)!)) return;
  }
  if (keys.get('Type') !== 'Application' || !keys.get('Name') || ['Hidden', 'NoDisplay', 'Terminal'].some(key => keys.get(key) === 'true')) return;
  if (!keys.get('Exec') && keys.get('DBusActivatable') !== 'true') return;
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').split(':');
  if (keys.has('OnlyShowIn') && !values(keys.get('OnlyShowIn')).some(value => desktops.includes(value))) return;
  if (values(keys.get('NotShowIn')).some(value => desktops.includes(value))) return;
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || 'C').replace(/\.[^@]+/, '');
  const [base, modifier] = locale.split('@');
  const language = base!.split('_')[0]!;
  const locales = [...new Set([locale, base!, ...(modifier ? [`${language}@${modifier}`] : []), language])];
  const name = locales.map(value => keys.get(`Name[${value}]`)).find(Boolean) ?? keys.get('Name')!;
  return { name: unescape(name), ...(keys.get('TryExec') ? { tryExec: unescape(keys.get('TryExec')!) } : {}) };
}

export class LinuxAppLauncher implements AppLauncherAdapter {
  private readonly roots: string[];
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly run: LauncherTool = runLauncherTool) {
    const home = env.HOME || homedir();
    this.roots = [...new Set([env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local/share'),
      ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(isAbsolute)])].map(root => join(root, 'applications'));
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new ProtocolError('UNAUTHENTICATED');
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
  }
  private async read(path: string): Promise<{ bytes: Buffer; target: string }> {
    const target = await realpath(path);
    const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
      const bytes = Buffer.alloc(MAX_ENTRY_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_ENTRY_BYTES) throw new ProtocolError('LAUNCHER_UNAVAILABLE');
      return { bytes: bytes.subarray(0, total), target };
    } finally { await file.close(); }
  }
  private async canExecute(value?: string): Promise<boolean> {
    if (!value) return true;
    const paths = isAbsolute(value) ? [value] : value.includes('/') ? []
      : (this.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter(isAbsolute).map(root => join(root, value));
    for (const path of paths) { try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return true; } catch { /* Try the next explicit PATH directory. */ } }
    return false;
  }
  async list(signal: AbortSignal): Promise<NativeApp[]> {
    this.check(signal);
    await this.run('gio', ['version'], { signal });
    const seen = new Set<string>(); const result: NativeApp[] = [];
    let scanned = 0;
    for (const root of this.roots) {
      const candidates = new Map<string, string | null>();
      const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
        this.check(signal);
        let children;
        try { children = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        for (const child of children) {
          if (++scanned > MAX_SCAN_ITEMS) throw new ProtocolError('LAUNCHER_LIMIT');
          const path = join(directory, child.name);
          const key = `${prefix}${child.name}`;
          if (child.isDirectory()) {
            if (depth >= MAX_DEPTH) throw new ProtocolError('LAUNCHER_LIMIT');
            await walk(path, `${key}-`, depth + 1);
          } else if (child.name.endsWith('.desktop') && (child.isFile() || child.isSymbolicLink())) {
            candidates.set(key, candidates.has(key) ? null : path);
          }
        }
      };
      await walk(root, '', 0);
      for (const [key, path] of candidates) {
        if (seen.has(key)) continue;
        // Hidden or invalid higher-priority entries mask lower-priority registrations too.
        seen.add(key);
        if (!path) continue;
        this.check(signal);
        try {
          const { bytes, target } = await this.read(path);
          const entry = desktopEntry(new TextDecoder('utf-8', { fatal: true }).decode(bytes), this.env);
          if (entry && await this.canExecute(entry.tryExec)) result.push({ key: path, name: entry.name, revision: digest(`${target}\0${digest(bytes)}`) });
        } catch (error) {
          if (signal.aborted) throw error;
          // Unreadable or malformed individual registrations never become launchable entries.
        }
        if (result.length > MAX_APPS) throw new ProtocolError('LAUNCHER_LIMIT');
      }
    }
    return result;
  }
  async launch(app: NativeApp, authorize: () => void, signal: AbortSignal): Promise<void> {
    this.check(signal);
    const { bytes, target } = await this.read(app.key);
    if (digest(`${target}\0${digest(bytes)}`) !== app.revision) throw new ProtocolError('LAUNCHER_STALE_CATALOG');
    authorize();
    await this.run('gio', ['launch', app.key], { signal, activation: true });
  }
}
