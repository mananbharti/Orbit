/** Uses explicit Wayland or X11 clipboard tools; depends on wl-clipboard or xclip; never falls back between display systems or invokes a shell. */
import { spawn } from 'node:child_process';
import { clipboardTextSchema, MAX_CLIPBOARD_BYTES, type ClipboardSnapshot } from '../protocol/clipboard.js';
import { ClipboardUnavailable, type ClipboardAdapter } from './clipboard.js';

const TOOL_TIMEOUT_MS = 3_000;
const MAX_FORMAT_BYTES = 16 * 1_024;
export interface ToolResult { code: number | null; output: Buffer; error: string; overflow: boolean }
export type ClipboardTool = (file: string, args: string[], limit: number, input?: string) => Promise<ToolResult>;

export const runClipboardTool: ClipboardTool = (file, args, limit, input) => new Promise((resolve, reject) => {
  // Writers fork a selection owner on Linux. Ignoring their output prevents that owner's inherited
  // pipe from holding this request open; it exits when another application owns the selection.
  const child = spawn(file, args, { stdio: ['pipe', input === undefined ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
  let output = Buffer.alloc(0);
  let error = '';
  let overflow = false;
  let failed = false;
  const fail = () => { failed = true; child.kill(); clearTimeout(timer); reject(new ClipboardUnavailable()); };
  const timer = setTimeout(fail, TOOL_TIMEOUT_MS);
  child.stdout?.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > limit) { overflow = true; child.kill(); }
    else if (!overflow) output = Buffer.concat([output, chunk]);
  });
  child.stderr?.on('data', (chunk: Buffer) => { if (error.length < MAX_FORMAT_BYTES) error += chunk.toString('utf8').slice(0, MAX_FORMAT_BYTES - error.length); });
  child.stdin?.on('error', fail);
  child.on('error', fail);
  const finish = (code: number | null) => {
    clearTimeout(timer);
    child.stderr?.destroy();
    if (!failed) resolve({ code, output, error, overflow });
  };
  child.once(input === undefined ? 'close' : 'exit', finish);
  child.stdin?.end(input === undefined ? undefined : Buffer.from(input, 'utf8'));
});

export class LinuxClipboard implements ClipboardAdapter {
  private disposed = false;
  private readonly wayland: boolean;
  constructor(environment: NodeJS.ProcessEnv = process.env, private readonly run: ClipboardTool = runClipboardTool) {
    this.wayland = !!environment.WAYLAND_DISPLAY || environment.XDG_SESSION_TYPE === 'wayland';
    if (this.wayland ? !environment.WAYLAND_DISPLAY : !environment.DISPLAY) throw new ClipboardUnavailable();
  }

  async read(): Promise<ClipboardSnapshot> {
    this.check();
    const formats = await this.run(this.wayland ? 'wl-paste' : 'xclip',
      this.wayland ? ['--list-types'] : ['-selection', 'clipboard', '-out', '-target', 'TARGETS'], MAX_FORMAT_BYTES);
    if (formats.code !== 0 || formats.overflow) {
      if (formats.code === 1 && /Nothing is copied|No selection|target TARGETS not available/i.test(formats.error)) return { kind: 'unsupported' };
      throw new ClipboardUnavailable();
    }
    const types = formats.output.toString('utf8').trim().split(/\r?\n/).map(value => value.trim());
    if (types.some(type => /^(image\/|text\/(html|rtf|uri-list)$|application\/(rtf|x-kde-cutselection)$|x-special\/gnome-copied-files$)/i.test(type))) {
      return { kind: 'unsupported' };
    }
    const target = (this.wayland ? ['text/plain;charset=utf-8', 'text/plain'] : ['UTF8_STRING', 'text/plain;charset=utf-8', 'text/plain'])
      .find(type => types.includes(type));
    if (!target) return { kind: 'unsupported' };
    this.check();
    const result = await this.run(this.wayland ? 'wl-paste' : 'xclip', this.wayland
      ? ['--no-newline', '--type', target] : ['-selection', 'clipboard', '-out', '-target', target], MAX_CLIPBOARD_BYTES);
    if (result.overflow) return { kind: 'oversized' };
    if (result.code !== 0) throw new ClipboardUnavailable();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.output); }
    catch { return { kind: 'unsupported' }; }
    return clipboardTextSchema.safeParse(text).success ? { kind: 'text', text } : { kind: 'unsupported' };
  }

  async write(text: string): Promise<void> {
    this.check();
    if (!clipboardTextSchema.safeParse(text).success) throw new ClipboardUnavailable();
    const result = await this.run(this.wayland ? 'wl-copy' : 'xclip', this.wayland
      ? ['--type', 'text/plain;charset=utf-8'] : ['-selection', 'clipboard', '-in', '-target', 'UTF8_STRING'], 0, text);
    if (result.code !== 0) throw new ClipboardUnavailable();
  }

  async dispose(): Promise<void> { this.disposed = true; }
  private check(): void { if (this.disposed) throw new ClipboardUnavailable(); }
}
