/** Runs bounded native launcher helpers without a shell; depends on Node child processes; never logs native diagnostics or retries activation. */
import { spawn } from 'node:child_process';
import { ProtocolError } from '../protocol/errors.js';

const TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 2 * 1_024 * 1_024;
export interface LauncherToolOptions { signal: AbortSignal; input?: string; authorize?: () => void; activation?: boolean }
export type LauncherTool = (file: string, args: string[], options: LauncherToolOptions) => Promise<string>;
export const runLauncherTool: LauncherTool = (file, args, options) => new Promise((resolve, reject) => {
  if (options.signal.aborted) { reject(new ProtocolError('UNAUTHENTICATED')); return; }
  const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  let output = ''; let length = 0; let done = false; let authorized = false;
  const finish = (error?: unknown) => {
    if (done) return;
    done = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    child.stdin.destroy(); child.stdout.destroy();
    if (error) { child.kill(); reject(error); } else resolve(output);
  };
  const abort = () => finish(new ProtocolError('UNAUTHENTICATED'));
  const timer = setTimeout(() => finish(new ProtocolError(options.activation ? 'LAUNCHER_UNKNOWN_OUTCOME' : 'LAUNCHER_UNAVAILABLE')), TIMEOUT_MS);
  options.signal.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (done) return;
    length += Buffer.byteLength(chunk);
    if (length > MAX_OUTPUT_BYTES) { finish(new ProtocolError('LAUNCHER_LIMIT')); return; }
    output += chunk;
    if (options.authorize && !authorized && output.startsWith('READY\n')) {
      try {
        options.authorize(); authorized = true; output = output.slice(6);
        child.stdin.end('GO\n');
      } catch (error) { finish(error); }
    }
  });
  child.on('error', () => finish(new ProtocolError('LAUNCHER_UNAVAILABLE')));
  child.stdin.on('error', () => finish(new ProtocolError(options.activation ? 'LAUNCHER_UNKNOWN_OUTCOME' : 'LAUNCHER_UNAVAILABLE')));
  // Applications may inherit helper handles; completion follows the helper's exit, not its descendants.
  child.on(options.activation ? 'exit' : 'close', code => finish(code === 0 && (!options.authorize || authorized) ? undefined
    : new ProtocolError(code === 3 && options.authorize ? 'LAUNCHER_STALE_CATALOG' : options.activation ? 'LAUNCHER_UNKNOWN_OUTCOME' : 'LAUNCHER_UNAVAILABLE')));
  if (options.authorize) child.stdin.write(`${options.input}\n`);
  else child.stdin.end(options.input === undefined ? undefined : `${options.input}\n`);
});
