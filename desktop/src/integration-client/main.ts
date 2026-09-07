/** Runs the local TypeScript integration harness; depends on paired feature clients; displays the requested app catalog but never secrets, file contents or clipboard payloads. */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pairingPayloadSchema } from '../protocol/pairing.js';
import { privateDirectory } from '../security-pairing/private-directory.js';
import { discoverDesktop } from '../transport/discovery/lan-discovery.js';
import { pairDesktop } from './pair-desktop.js';
import { loadPairedDesktop, savePairedDesktop } from './paired-desktop.js';
import { OrbitClient } from './orbit-client.js';
import { ClipboardClient } from './clipboard-client.js';
import { createClipboard } from '../os-integration/create-clipboard.js';
import { ClipboardUnavailable } from '../os-integration/clipboard.js';
import { FileClient } from './file-client.js';
import { ProtocolError } from '../protocol/errors.js';
import { LauncherClient } from './launcher-client.js';

async function main(): Promise<void> {
  const directory = privateDirectory(process.env.ORBIT_CLIENT_DIR ?? '.local/client');
  const [action, qrPath] = process.argv.slice(2);
  if (action === 'pair') {
    if (!qrPath) throw new Error('Pairing file required');
    const qr = pairingPayloadSchema.parse(JSON.parse(readFileSync(qrPath, 'utf8')));
    const hint = await discoverDesktop(qr);
    savePairedDesktop(directory, await pairDesktop(qr, hint));
    console.info('Pairing completed. The device credential is stored in the private client directory.');
    return;
  }
  if (!['connect', 'clipboard', 'files', 'launcher'].includes(action ?? '')) throw new Error('Use pair <pairing.json>, connect, clipboard, files, or launcher');
  const paired = loadPairedDesktop(directory);
  const client = new OrbitClient(paired, async signal => (await discoverDesktop(paired, 10_000, signal)).endpoint);
  client.on('status', status => console.info(`Orbit client: ${String(status)}`));
  client.on('desktop-event', () => console.info('Desktop event received; payload omitted.'));
  const clipboard = action === 'clipboard' || (['files', 'launcher'].includes(action!) && process.argv.includes('--clipboard')) ? new ClipboardClient(client, createClipboard()) : undefined;
  const launcher = action === 'launcher' ? new LauncherClient(client) : undefined;
  const files = action === 'files' ? new FileClient(client, directory, paired.desktopServiceId) : undefined;
  files?.on('status', status => console.info(`File Transfer: ${JSON.stringify(status)}`));
  if (files) console.info(`File Transfer device ID: ${paired.deviceId}`);
  clipboard?.on('status', status => console.info(`Clipboard Sync: ${String(status)}`));
  try { await client.start(); } catch (error) { launcher?.stop(); await files?.stop(); await clipboard?.stop(); throw error; }
  const input = createInterface({ input: process.stdin });
  const stop = () => {
    client.stop(); input.close(); process.stdin.destroy();
    launcher?.stop();
    void clipboard?.stop().catch(() => console.info('Clipboard Sync stopped with an OS adapter error.'));
    void files?.stop().catch(() => console.info('File Transfer stopped with a storage error.'));
  };
  input.on('line', line => {
    if (line.trim() === 'quit') { stop(); return; }
    if (launcher) {
      void (async () => {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid launcher command');
        if (value.type === 'list') {
          for (const app of await launcher.list()) console.info(JSON.stringify(app));
          console.info('App catalog ready. Select an appId to launch.');
        } else if (value.type === 'launch' && 'appId' in value && typeof value.appId === 'string') {
          await launcher.launch(value.appId); console.info('Launch requested; verify the app on the desktop.');
        } else throw new Error('Invalid launcher command');
      })().catch(error => console.info(error instanceof ProtocolError ? `App Launcher: ${error.code}; list again if the catalog changed.`
        : 'App Launcher request failed or its outcome is unknown. It will not be replayed.'));
      return;
    }
    if (files) {
      void (async () => {
        const value = JSON.parse(line) as { type?: string; path?: string; transferId?: string };
        if (value.type === 'upload' && typeof value.path === 'string') console.info(`Transfer started: ${await files.upload(value.path)}`);
        else if (value.type === 'offers') for (const offer of await files.offers()) console.info(`Offered transfer: ${offer.transferId}; bytes: ${offer.sizeBytes}`);
        else if (value.type === 'download' && typeof value.transferId === 'string') await files.download(value.transferId);
        else if (value.type === 'resume' && typeof value.transferId === 'string') files.resume(value.transferId);
        else if (value.type === 'cancel' && typeof value.transferId === 'string') await files.cancel(value.transferId);
        else throw new Error('Invalid file command');
      })().catch(error => console.info(error instanceof ProtocolError ? `File command rejected: ${error.code}` : 'File operation could not complete; no command was replayed.'));
      return;
    }
    if (clipboard) { console.info('Clipboard Sync is active; copy plain text in another application, or enter quit.'); return; }
    try {
      const message = JSON.parse(line) as { type: string; payload: import('../protocol/messages.js').JsonValue };
      void client.command(message.type, message.payload).then(response => {
        console.info(response.payload.ok ? 'Command succeeded; result omitted.' : `Command rejected: ${response.payload.error.code}`);
      }).catch(() => console.info('Command failed or its outcome is unknown; no replay was attempted.'));
    } catch { console.info('Enter a JSON command with type and payload, or quit.'); }
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(error => {
  console.error(error instanceof ClipboardUnavailable
    ? 'Clipboard Sync is unavailable. Check desktop session access and wl-clipboard (Wayland) or xclip (X11) on Linux.'
    : 'Orbit integration client could not complete the operation. Check pairing, LAN discovery, and private storage.');
  process.exitCode = 1;
});
