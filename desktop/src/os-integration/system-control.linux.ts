/** Linux power/volume/brightness through standard session tools; depends on logind/pactl/brightnessctl; fails closed when absent. */
import { execFile } from 'node:child_process';
import type { DisplayMode, SystemControlAdapter } from './system-control.js';
import { SystemControlUnavailable } from './system-control.js';

const TIMEOUT_MS = 10_000;
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) reject(new SystemControlUnavailable(`${file}: ${String(error.message).slice(0, 100)}`));
      else resolve(String(stdout).trim());
    });
  });
}

export class LinuxSystemControl implements SystemControlAdapter {
  async power(action: 'lock' | 'sleep' | 'restart' | 'shutdown'): Promise<void> {
    if (action === 'lock') await run('loginctl', ['lock-session']);
    else if (action === 'sleep') await run('systemctl', ['suspend']);
    else if (action === 'restart') await run('systemctl', ['reboot']);
    else await run('systemctl', ['poweroff']);
  }
  async getVolume(): Promise<{ level: number; muted: boolean }> {
    const out = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    const mute = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
    const m = /(\d{1,3})%/.exec(out);
    if (!m) throw new SystemControlUnavailable('Could not read the master volume');
    return { level: Math.min(100, Number(m[1])), muted: /Mute:\s*yes/.test(mute) };
  }
  async setVolume(level: number, muted?: boolean): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new SystemControlUnavailable('Volume must be 0-100');
    await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${level}%`]);
    if (typeof muted === 'boolean') await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']);
  }
  async getBrightness(): Promise<number | null> {
    try {
      const max = Number(await run('brightnessctl', ['max']));
      const cur = Number(await run('brightnessctl', ['get']));
      if (!max || !Number.isFinite(cur)) return null;
      return Math.round((cur / max) * 100);
    } catch { return null; }
  }
  async setBrightness(level: number): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new SystemControlUnavailable('Brightness must be 0-100');
    await run('brightnessctl', ['set', `${level}%`]);
  }
  async getDisplayMode(): Promise<DisplayMode> {
    try {
      const out = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
      const theme = out.includes('prefer-dark') ? 'dark' : out.includes('default') ? 'light' : null;
      return { theme, nightLight: null };
    } catch { return { theme: null, nightLight: null }; }
  }
  async setDisplayMode(mode: { theme?: 'dark' | 'light'; nightLight?: boolean }): Promise<void> {
    if (mode.theme) await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', mode.theme === 'dark' ? 'prefer-dark' : 'default']);
    if (typeof mode.nightLight === 'boolean') throw new SystemControlUnavailable('Night light is not supported on this system');
  }
}
