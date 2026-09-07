/** Runs Orbit Desktop with local pairing and file-selection controls; depends on the service and QR renderer; never prints credentials or accepts remote source paths. */
import { createInterface } from 'node:readline';
import { readConfig } from './config.js';
import { startDesktop } from './desktop-service.js';
import { showPairing } from './security-pairing/pairing-display.js';

async function main(): Promise<void> {
  const service = await startDesktop(readConfig());
  const input = createInterface({ input: process.stdin });
  let cleanup: (() => void) | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let opening = false;
  let stopping = false;
  const removeInvitation = () => {
    try { cleanup?.(); }
    catch { service.log.record({ severity: 'warn', eventType: 'pairing.rejected', outcome: 'failed' }); }
  };
  const open = async () => {
    if (opening || stopping) return;
    opening = true;
    try {
      clearTimeout(expiry);
      removeInvitation();
      const payload = service.pairing.open();
      cleanup = await showPairing(service.directory, payload);
      if (stopping) { removeInvitation(); return; }
      expiry = setTimeout(() => { service.pairing.close(); removeInvitation(); }, Math.max(1, payload.expiresAt - Date.now()));
      console.info('Pairing is open for two minutes. Open pairing.svg in the private data directory; pairing.json is for the integration client.');
    } catch {
      service.pairing.close();
      console.error('Could not display the pairing invitation. Check the private data directory.');
    } finally { opening = false; }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(expiry);
    removeInvitation();
    input.close();
    // Closing readline alone leaves a piped stdin handle alive in a background service.
    process.stdin.destroy();
    await service.stop();
  };
  const stopSafely = () => { void stop().catch(() => { process.exitCode = 1; }); };
  input.on('line', line => {
    if (line.trim() === 'pair') void open();
    if (line.trim() === 'quit') stopSafely();
    if (line.trim().startsWith('{')) {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'file.offer'
          || !('deviceId' in value) || typeof value.deviceId !== 'string' || !('path' in value) || typeof value.path !== 'string') throw new Error('Invalid local offer');
        void service.files.offerLocal(value.path, value.deviceId).then(manifest => console.info(`File offered: ${manifest.transferId}`))
          .catch(() => console.error('Local file offer failed. Check device ID, selected file, and transfer limits.'));
      } catch { console.error('Invalid local file offer command.'); }
    }
  });
  process.once('SIGINT', stopSafely);
  process.once('SIGTERM', stopSafely);
  console.info('Orbit Desktop is listening. Enter pair to open pairing, or quit to stop.');
  if (process.argv.includes('--pair')) await open();
}

void main().catch(() => {
  console.error('Orbit Desktop could not start. Check the local endpoint, private data directory, identity, and service lock.');
  process.exitCode = 1;
});
