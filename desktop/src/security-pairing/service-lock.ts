/** Prevents concurrent writers to one desktop identity/store; depends on exclusive local files; removes a lock only when its owning process is gone. */
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } // EPERM: exists but owned by someone else
}

function tryCreate(path: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
}

export function lockService(directory: string): () => void {
  const path = join(directory, 'service.lock');
  try { tryCreate(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A crash, End Task or power cut leaves the file behind. Recover only if the recorded owner is no longer running.
    const pid = Number.parseInt((() => { try { return readFileSync(path, 'utf8'); } catch { return ''; } })(), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error('Orbit is already running on this computer (check the tray icon or Task Manager)');
    }
    try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    tryCreate(path);
  }
  return () => { try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } };
}
