/** Runs Orbit Desktop with local pairing and file-selection controls; depends on the service and QR renderer; never prints credentials or accepts remote source paths. */
import { parseScopes } from './security-pairing/scopes.js';
import { createInterface } from 'node:readline';
import { readConfig } from './config.js';
import { startDesktop } from './desktop-service.js';
import { showPairing } from './security-pairing/pairing-display.js';
import { WindowsInputDevice } from './os-integration/input-device.windows.js';
import { windowsApproval } from './security-pairing/windows-approval.js';
import { WhisperCpp } from './dictation/whisper-cpp.js';
import { ffmpegDecoder } from './dictation/ffmpeg-decoder.js';
import { HermesRunner } from './agent/hermes-runner.js';

async function main(): Promise<void> {
  // Agent tasks stay disabled unless a local Hermes gateway key is provided; the key is never logged.
  const hermesKey = process.env.ORBIT_HERMES_API_KEY;
  const agent = hermesKey ? { runner: new HermesRunner({ apiKey: hermesKey, baseUrl: process.env.ORBIT_HERMES_URL }) } : undefined;
  // Remote mouse/keyboard is opt-in and every session needs a Yes at the PC. The CLI approval dialog is PowerShell, so the CLI stays Windows-only; the Electron app also supports Linux/X11.
  const remoteInput = process.platform === 'win32' && process.env.ORBIT_ENABLE_REMOTE_INPUT === '1'
    ? { createDevice: () => new WindowsInputDevice(), confirmation: windowsApproval() } : undefined;
  // Remote terminal: opt-in, Windows only, every session needs a Yes at the PC. Untested on a real PC.
  const terminal = process.platform === 'win32' && process.env.ORBIT_ENABLE_TERMINAL === '1'
    ? { confirmation: windowsApproval(undefined, undefined, 'terminal') } : undefined;
  // Dictation is off unless a local whisper.cpp binary and model are named. ORBIT_FFMPEG additionally lets Android phones send compressed audio.
  const whisperBin = process.env.ORBIT_WHISPER_BIN; const whisperModel = process.env.ORBIT_WHISPER_MODEL; const ffmpeg = process.env.ORBIT_FFMPEG;
  const dictation = whisperBin && whisperModel
    ? { engine: new WhisperCpp({ binary: whisperBin, model: whisperModel }), ...(ffmpeg ? { decoder: ffmpegDecoder(ffmpeg) } : {}) } : undefined;
  const service = await startDesktop({ ...readConfig(), agent, ...(remoteInput ? { input: remoteInput } : {}), ...(dictation ? { dictation } : {}), ...(terminal ? { terminal } : {}) });
  const input = createInterface({ input: process.stdin });
  let cleanup: (() => void) | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let opening = false;
  let stopping = false;
  const removeInvitation = () => {
    try { cleanup?.(); }
    catch { service.log.record({ severity: 'warn', eventType: 'pairing.rejected', outcome: 'failed' }); }
  };
  const pairScopes = parseScopes(process.env.ORBIT_PAIR_SCOPES); // invalid values fail at startup, not at pairing time
  const open = async () => {
    if (opening || stopping) return;
    opening = true;
    try {
      clearTimeout(expiry);
      removeInvitation();
      const payload = service.pairing.open(pairScopes);
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
    if (line.trim() === 'devices') {
      const rows = service.credentials.list();
      console.info(rows.length ? rows.map(d => `${d.deviceId}  scopes: ${d.scopes === 'all' ? 'all' : d.scopes.join(',')}`).join('\n') : 'No paired devices.');
    }
    if (line.trim().startsWith('revoke ')) {
      const id = line.trim().slice(7).trim();
      const done = service.credentials.revoke(id);
      if (done) service.log.record({ severity: 'warn', eventType: 'pairing.revoked', deviceId: id, outcome: 'success' });
      console.info(done ? 'Device unpaired. It stops working on its next request.' : 'No paired device has that id (type devices to list them).');
    }
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
  console.info('Orbit Desktop is listening. Enter pair to open pairing, devices to list phones, revoke <id> to unpair one, or quit to stop.');
  if (process.argv.includes('--pair')) await open();
}

void main().catch(() => {
  console.error('Orbit Desktop could not start. Check the local endpoint, private data directory, identity, and service lock.');
  process.exitCode = 1;
});
