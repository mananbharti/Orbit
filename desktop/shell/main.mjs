// Orbit Desktop shell: a tray + window around the existing service. Depends on Electron and the compiled service in ../dist.
// Runs the service in-process, shows a pairing QR only when the user asks, and never exposes the service to the page except through preload.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, Tray, Menu, Notification, clipboard as electronClipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, basename } from 'node:path';
import QRCode from 'qrcode';
import { transferRows, freshTerminalTransfers, notificationFor, knownPath as knownTransferPath } from './logic.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { startDesktop } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'desktop-service.js')).href);
const { pickLanAddress, defaultRouteAddress } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'lan-address.js')).href);
const { DEFAULT_PORT } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'config.js')).href);
const { createClipboard } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'os-integration', 'create-clipboard.js')).href);
const { inputDeviceFactory } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'os-integration', 'create-input-device.js')).href);
const { createDictationInsertion } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'create-insertion.js')).href);
const { hostname } = await import('node:os');
const { HermesRunner } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'agent', 'hermes-runner.js')).href);
const { loadAgentConfig, saveAgentConfig, clearAgentConfig, validateAgentConfig } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'agent-config.js')).href);
const { LayaClient } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'router', 'laya-engine.js')).href);
const { LocalLlmClient } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'router', 'local-llm.js')).href);

// Chromium's disk caches are useless for a local UI and fail with "Access is denied" when a previous
// instance still holds them (or the profile sits in a synced folder), so keep them off and in a private folder.
app.setName('Orbit');
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0); // a second launch only focuses the first window (see 'second-instance')

let win; let tray; let service; let pairingTimer; let pairingUntil = 0; let state = { phase: 'starting' };
let quitting = false; let restarting = false;
let agentGateway = 'unknown'; // 'unknown' | 'ok' | 'unauthorized' | 'unreachable' | 'error'
let agentLaya = 'unknown'; // 'unknown' | 'found' | 'missing' - is a Laya decision model answering on the configured loopback address?
async function probeLaya(settings) {
  if (!settings) { agentLaya = 'unknown'; return; }
  try { agentLaya = await new LayaClient(process.env.ORBIT_LAYA_URL ?? settings.layaUrl ?? 'http://127.0.0.1:8000').healthy() ? 'found' : 'missing'; }
  catch { agentLaya = 'missing'; }
  push();
}
async function probeAgentGateway(settings) {
  if (!settings) { agentGateway = 'unknown'; return; }
  try {
    const runner = new HermesRunner({ apiKey: settings.apiKey, ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}) });
    agentGateway = await runner.check();
  } catch { agentGateway = 'error'; }
  push();
}
// Agent tasks (Hermes gateway): the key lives only in OS-encrypted storage; ORBIT_HERMES_API_KEY still wins for the CLI.
const agentConfigPath = () => join(app.getPath('userData'), 'orbit-agent.json');
const agentEncrypt = plaintext => safeStorage.encryptString(plaintext).toString('base64');
const agentDecrypt = blob => safeStorage.decryptString(Buffer.from(blob, 'base64'));
function agentSettings() {
  if (process.env.ORBIT_HERMES_API_KEY) return { apiKey: process.env.ORBIT_HERMES_API_KEY, baseUrl: process.env.ORBIT_HERMES_URL, source: 'env' };
  const saved = loadAgentConfig(agentConfigPath(), agentDecrypt);
  return saved ? { ...saved, source: 'saved' } : undefined;
}
let clip; try { clip = createClipboard(); } catch { clip = undefined; }
// Transfers that were already finished when the app booted must not notify; only fresh ones do.
const seenTerminal = new Set(); let seeded = false;

async function boot() {
  const host = process.env.ORBIT_HOST || pickLanAddress(undefined, await defaultRouteAddress());
  if (!host) { state = { phase: 'offline' }; return; }
  try {
    // Remote mouse/keyboard: Windows only, and every session needs a Yes on a dialog shown at this PC (below).
    // Remote mouse/keyboard: Windows (SendInput) and Linux (xdotool on X11, a uinput virtual device on Wayland). Every session still needs a Yes in this window.
    const inputFactory = inputDeviceFactory();
    const remoteInput = inputFactory ? { createDevice: inputFactory, confirmation: electronApproval } : undefined;
    // Remote terminal: every session needs a Yes on a dialog shown at this PC (below), same as remote control.
    // Remote terminal: the service runs cmd.exe on Windows and POSIX sh on Linux; every session needs a Yes in this window.
    const terminal = (process.platform === 'win32' || process.platform === 'linux') ? { confirmation: electronApproval } : undefined;
    // Agent tasks: on when a Hermes gateway key is configured (Settings > Agent, or the env var for the CLI).
    const hermes = agentSettings();
    let agent;
    if (hermes) {
      const layaUrl = process.env.ORBIT_LAYA_URL ?? hermes.layaUrl;
      try { agent = { runner: new HermesRunner({ apiKey: hermes.apiKey, ...(hermes.baseUrl ? { baseUrl: hermes.baseUrl } : {}) }), ...(layaUrl ? { layaUrl } : {}), ...(hermes.fastModel ? { fastModel: hermes.fastModel } : {}) }; }
      catch (error) { console.error('AGENT: disabled -', String(error?.message ?? error)); }
    }
    const { CommandRegistry } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'command-router', 'command-registry.js')).href);
    const registry = new CommandRegistry();
    const dataDir = join(app.getPath('userData'), 'orbit-data');
    dictationDataDir = dataDir;
    service = await startDesktop({ directory: dataDir, host, port: DEFAULT_PORT,
      displayName: hostname().slice(0, 64), ...(remoteInput ? { input: remoteInput } : {}), ...(terminal ? { terminal } : {}), ...(agent ? { agent } : {}), biometric: electronApproval, registry, onExtensionConnection: () => push() });
    service.log.onRecord = () => queueStatePush();
    // Dictation: one visible setup machine - status always answers, retry is user-triggered, cancel aborts the download; the engine registers when verified.
    const { DictationSetup } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'provision.js')).href);
    const { WhisperCpp } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'whisper-cpp.js')).href);
    const { DictationService } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'dictation-service.js')).href);
    let dictationServiceRef;
    const attachDictation = paths => { localDictationEngine = new WhisperCpp(paths); if (dictationServiceRef) dictationServiceRef.swapEngine(localDictationEngine); else dictationServiceRef = new DictationService(registry, localDictationEngine, service.log); };
    attachDictationRef = attachDictation;
    const { LocalDictation } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'local-dictation.js')).href);
    const { dictate } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'pipeline.js')).href);
    const { focusProbeFor, focusActivatorFor } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'local-insert.js')).href);
    dictationProbe = focusProbeFor(); dictationActivator = focusActivatorFor();
    // Linux/X11 inserts through the same allowlisted paste path as the phone-confirmed flow; its captureFocus only yields a target whose paste binding is known, so the Insert button never appears for an unknown window class.
    dictationInsertion = process.platform === 'linux' ? createDictationInsertion() : undefined;
    // No verified delivery path (Windows typing removed, see type-now) means no captured target, so the preview shows Copy/Dismiss only - never an unverified Insert.
    const captureProbe = dictationInsertion ? { current: dictationInsertion.captureFocus } : undefined;
    localDictation = new LocalDictation({ ...(captureProbe ? { probe: captureProbe } : {}),
      transcribe: async pcm => { if (!localDictationEngine) return undefined; const r = await dictate(pcm, localDictationEngine, { signal: new AbortController().signal }); return r.status === 'text' ? r.text : undefined; },
      onPreview: dictationPreview, onState: dictationStatePush,
      onEmpty: reason => dictationWin?.webContents.send('orbit:dictation-empty', reason) });
    dictationHotkeyApply(dictationHotkeyGet());
    const dictationSetup = new DictationSetup(registry, dataDir, attachDictation, service.log, { model: dictationHotkeyGet().model });
    dictationSetupRef = dictationSetup;
    if (process.env.ORBIT_WHISPER_BIN && process.env.ORBIT_WHISPER_MODEL) {
      try { attachDictation({ binary: process.env.ORBIT_WHISPER_BIN, model: process.env.ORBIT_WHISPER_MODEL }); dictationSetup.markReady(); }
      catch { service.log.record({ severity: 'info', eventType: 'dictation.engine_unavailable', outcome: 'failed' }); }
    } else {
      const existing = dictationSetup.autoStart();
      if (existing) { try { attachDictation(existing); } catch { service.log.record({ severity: 'info', eventType: 'dictation.engine_unavailable', outcome: 'failed' }); } }
    }
    state = { phase: 'running', host, port: DEFAULT_PORT };
    if (agent) { void probeAgentGateway(hermes); void probeLaya(hermes); } else { agentGateway = 'unknown'; agentLaya = 'unknown'; }
  } catch (error) {
    // Boot failures must be diagnosable from the log alone: message only, never paths, keys, or device data.
    console.error('BOOT: failed -', String(error?.message ?? error).slice(0, 200));
    state = { phase: 'error', message: String(error?.message ?? error).slice(0, 200) };
  }
}

function fileRows() {
  if (!service) return [];
  return transferRows(service.files.store.records.values(), (record) => service.files.store.paths(record).destination);
}

function notifyNewTransfers(rows) {
  if (!Notification.isSupported()) return;
  const result = freshTerminalTransfers(rows, seenTerminal, seeded);
  seeded = result.seeded;
  for (const row of result.fresh) {
    const note = notificationFor(row);
    if (!note) continue;
    const n = new Notification({ title: note.title, body: note.body, silent: false });
    if (note.reveal) n.on('click', () => { if (row.path) shell.showItemInFolder(row.path); win?.show(); });
    n.show();
  }
}

// PC-side approval for phone remote control: a focused native dialog, default Deny, 30s timeout.
const electronApproval = { verify: async (message, context) => {
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const formatDays = days => !days?.length ? 'every day'
    : `every ${[...days].sort((a, b) => a - b).map(d => DAY_NAMES[d] ?? `day ${d}`).join(', ')}`;
  const isInput = message.type.startsWith('input.');
  const isTerminal = message.type === 'terminal.begin';
  const isPower = message.type === 'system.power';
  if (!isInput && !isTerminal && !isPower) return false;
  if (!win || win.isDestroyed()) return false;
  const device = String(context?.session?.deviceId ?? 'unknown').slice(0, 8);
  win.show(); win.focus();
  const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Orbit',
    message: isPower ? 'Allow power action?' : isTerminal ? 'Allow terminal access?' : 'Allow remote control?',
    detail: isPower
      ? (message.payload?.schedule?.time
        ? `Your phone (device ${device}) wants to schedule ${message.payload?.action ?? 'a power action'} at ${message.payload.schedule.time} (this computer's local time) ${formatDays(message.payload.schedule.days)} on this computer. It fires unattended at that time.\n\nChoose Deny unless you just created this schedule on your phone.`
        : `Your phone (device ${device}) wants to ${message.payload?.action ?? 'change the power state of'} this computer.\n\nChoose Deny unless you just started this on your phone.`)
      : isTerminal
      ? `Your phone (device ${device}) wants to run commands on this computer. Commands can change or delete anything.\n\nChoose Deny unless you just started this on your phone.`
      : `Your phone (device ${device}) wants to move the mouse and type on this computer.\n\nChoose Deny unless you just started this on your phone.`,
    buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, noLink: true,
    signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 30000); return c.signal; })() }).catch(() => ({ response: 1 }));
  return response === 0;
} };

const snapshot = () => {
  const files = fileRows();
  notifyNewTransfers(files);
  return {
    ...state, pairingUntil: pairingUntil > Date.now() ? pairingUntil : 0, dark: nativeTheme.shouldUseDarkColors,
    pcName: hostname().slice(0, 64), files,
    devices: service ? service.credentials.list() : [],
    activity: service ? service.log.snapshot().slice(-60).reverse() : [],
    browserExtension: service ? { port: service.browserExtension.port, token: service.browserExtension.token, connected: service.browserExtension.connected() } : undefined,
    agent: {
      configured: Boolean(agentSettings()),
      active: Boolean(service && agentSettings()),
      secureStorage: safeStorage.isEncryptionAvailable(),
      gateway: agentGateway,
      laya: agentLaya,
      fastModel: agentSettings()?.fastModel ? { kind: agentSettings().fastModel.kind, model: agentSettings().fastModel.model } : undefined,
    },
  };
};

// Restart the service in place (agent settings changed); mirrors the Wi-Fi switch path.
async function restartService() {
  if (restarting || quitting) return;
  restarting = true;
  try {
    if (service) { const old = service; service = undefined; pairingUntil = 0; clearTimeout(pairingTimer); await old.stop(); }
    await boot();
  } finally { restarting = false; push(); }
}
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('orbit:state', snapshot()); };
// Activity events arrive in bursts (connect, session, chunk states); coalesce them into one state push so the Activity view refreshes live without a redraw storm.
let activityPushTimer;
const queueStatePush = () => { if (activityPushTimer) return; activityPushTimer = setTimeout(() => { activityPushTimer = undefined; push(); }, 750); activityPushTimer.unref?.(); };

// The page only ever acts on paths that belong to a known transfer record, never on text it typed itself.
function knownPath(candidate) {
  if (!service) return undefined;
  return knownTransferPath(service.files.store.records.values(), (record) => service.files.store.paths(record).destination, candidate);
}

ipcMain.handle('orbit:state', () => snapshot());
ipcMain.handle('orbit:dictation-get', async () => {
  const { suggestModel, MODEL_SIZES_MB } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'provision.js')).href);
  const { cpus, totalmem } = await import('node:os');
  return { ...dictationHotkeyGet(), state: localDictation?.current ?? 'idle', engine: Boolean(localDictationEngine), setup: dictationSetupRef ? dictationSetupRef.statusPayload() : undefined, suggested: suggestModel(cpus().length, totalmem() / (1024 ** 3)), sizes: MODEL_SIZES_MB };
});
ipcMain.handle('orbit:dictation-set-model', async (_e, model) => {
  if (!DICTATION_MODELS.includes(model)) return { ok: false };
  const cfg = dictationHotkeyGet();
  dictationHotkeySave(cfg.enabled, cfg.accelerator, model);
  dictationSetupRef?.setModel(model);
  const { assetsFor, resolveEnginePaths } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'dictation', 'provision.js')).href);
  if (!dictationDataDir) return { ok: false, reason: 'not ready yet' };
  const existing = resolveEnginePaths(process.env, dictationDataDir, assetsFor(model));
  if (existing) { try { attachDictationRef?.(existing); dictationSetupRef?.markReady(); } catch { return { ok: false, reason: 'engine failed to load' }; } }
  else void dictationSetupRef?.start(true); // visible, cancellable download of the newly picked model
  return { ok: true, downloaded: Boolean(existing) };
});
ipcMain.handle('orbit:dictation-set', (_e, enabled, accelerator) => {
  const cfg = dictationHotkeySave(enabled, accelerator);
  if (cfg.enabled && !localDictationEngine) void dictationSetupRef?.start(true); // enabling with no engine retries the one-time download right away
  if (!cfg.enabled && localDictation?.cancel()) dictationWin?.webContents.send('orbit:dictation-capture', 'abort'); // stopping the shortcut stops any recording immediately
  dictationHotkeyApply(cfg);
  return { ok: true, ...cfg };
});
ipcMain.handle('orbit:dictation-type-now', async () => {
  if (!dictationPending) return { ok: false, reason: 'nothing pending' };
  const { text, target } = dictationPending;
  // Insertion is offered only where the delivery path is verified - today that is the X11 paste path. The earlier Windows per-character typing was removed: keystrokes are not safe-by-category in arbitrary apps (command-mode editors, single-key shortcuts, terminal control/newline handling, non-text focused controls) and the wrong-target disclosure risk is independent of paste vs typing. It returns when a delivery path is verified on a real PC.
  if (!target || !dictationInsertion) return { ok: false, reason: 'no verified window target on this platform' };
  {
    // X11 paste path: one confirmed action, allowlisted targets only, single-use - the offer is consumed whatever the outcome, and there is no automatic retry after an ambiguous delivery.
    const out = await dictationInsertion.insert(target, text);
    if (out === 'paste-sent') { dictationPending = undefined; return { ok: true, via: 'paste' }; }
    if (out === 'focus-lost') { dictationPending = undefined; dictationWin?.webContents.send('orbit:dictation-preview', { hide: true }); return { ok: false, reason: 'focus changed during the paste - it may have gone to another window, so Orbit did not keep or retry the text. Re-dictate if needed.' }; }
    if (out === 'clipboard-unavailable') return { ok: false, reason: 'the clipboard holds something Orbit will not replace (a password, an image, or a very large item) - copy the text instead' };
    if (out === 'unsupported-target') return { ok: false, reason: 'Orbit does not know how to paste into that window - copy the text instead' };
    return { ok: false, reason: out === 'activation-failed' || out === 'focus-mismatch' ? 'that window is no longer focused - nothing was pasted' : 'the paste keystroke failed - nothing was sent' };
  }
});
ipcMain.handle('orbit:dictation-finish', async (_e, buffer) => {
  if (!localDictation || localDictation.current !== 'recording') return { ok: false };
  // An empty or malformed clip still completes the toggle so the state machine returns to idle.
  const pcm = buffer instanceof ArrayBuffer && buffer.byteLength > 0 && buffer.byteLength % 2 === 0 ? new Int16Array(buffer.slice(0)) : undefined;
  try { await localDictation.toggle(async () => pcm); } finally { await dictationReleaseDevice(); }
  return { ok: true };
});
ipcMain.handle('orbit:pair', async () => {
  if (!service) return { error: 'Orbit is not running yet.' };
  const payload = service.pairing.open();
  pairingUntil = payload.expiresAt;
  clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => { service.pairing.close(); pairingUntil = 0; push(); }, Math.max(1, payload.expiresAt - Date.now()));
  push();
  return { svg: await QRCode.toString(JSON.stringify(payload), { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }), expiresAt: payload.expiresAt };
});
ipcMain.handle('orbit:cancel-pair', () => { service?.pairing.close(); pairingUntil = 0; clearTimeout(pairingTimer); push(); });
ipcMain.handle('orbit:revoke', (_e, id) => { const ok = typeof id === 'string' && service?.credentials.revoke(id); push(); return Boolean(ok); });
ipcMain.handle('orbit:retry', async () => { await boot(); push(); });
ipcMain.handle('orbit:fast-detect', async () => {
  try {
    const server = await new LocalLlmClient().detect();
    if (!server) return { error: 'No Ollama or LM Studio server answered on this computer. Start one, then detect again.' };
    if (!server.models.length) return { error: `${server.kind === 'ollama' ? 'Ollama' : 'LM Studio'} is running but has no models downloaded yet.`, kind: server.kind, baseUrl: server.baseUrl, models: [] };
    return server;
  } catch (error) { return { error: String(error?.message ?? error) }; }
});
ipcMain.handle('orbit:agent-save', async (_e, key, baseUrl, layaUrl, fastModel) => {
  if (!safeStorage.isEncryptionAvailable()) return { error: 'Secure storage is not available on this system, so the key cannot be saved safely.' };
  let config;
  try { config = validateAgentConfig({ apiKey: key, baseUrl, layaUrl, ...(fastModel ? { fastModel } : {}) }); } catch (error) { return { error: String(error?.message ?? error) }; }
  saveAgentConfig(agentConfigPath(), config, agentEncrypt);
  await restartService();
  return { ok: true };
});
ipcMain.handle('orbit:agent-clear', async () => { clearAgentConfig(agentConfigPath()); await restartService(); return { ok: true }; });
ipcMain.handle('orbit:agent-test', async (_e, key, baseUrl) => {
  let config;
  try { config = validateAgentConfig({ apiKey: key, baseUrl }); } catch (error) { return { status: 'invalid', error: String(error?.message ?? error) }; }
  try { return { status: await new HermesRunner(config).check() }; }
  catch (error) { return { status: 'error', error: String(error?.message ?? error) }; }
});
ipcMain.handle('orbit:login-item', (_e, enable) => {
  if (typeof enable === 'boolean') app.setLoginItemSettings({ openAtLogin: enable });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('orbit:clipboard-read', async () => {
  if (!clip) return { kind: 'unavailable' };
  try { return await clip.read(); } catch { return { kind: 'unavailable' }; }
});
ipcMain.handle('orbit:clipboard-write', async (_e, text) => {
  if (!clip || typeof text !== 'string' || !text || text.length > 8 * 1024) return false;
  try { await clip.write(text); return true; } catch { return false; }
});
ipcMain.handle('orbit:file-open', (_e, path) => { const p = knownPath(path); if (p) void shell.openPath(p); return Boolean(p); });
ipcMain.handle('orbit:file-reveal', (_e, path) => { const p = knownPath(path); if (p) shell.showItemInFolder(p); return Boolean(p); });
ipcMain.handle('orbit:open-inbox', () => { if (!service) return false; void shell.openPath(service.files.store.inbox); return true; });
ipcMain.handle('orbit:file-copy-path', (_e, path) => { const p = knownPath(path); if (p) electronClipboard.writeText(p); return Boolean(p); });
// Retry of a failed outgoing transfer: keyed by transfer id, so the renderer never supplies a path - the
// original recorded source is re-offered to the same phone, and only while the file is still there.
ipcMain.handle('orbit:file-retry', async (_e, id) => {
  if (!service || typeof id !== 'string' || id.length > 128) return { error: 'Orbit is not running yet.' };
  const record = [...service.files.store.records.values()].find(r => r.manifest.transferId === id);
  if (!record || record.manifest.direction !== 'to-client' || record.state !== 'failed' || !record.sourcePath) return { error: 'That transfer cannot be retried.' };
  if (!existsSync(record.sourcePath)) return { error: 'The original file is no longer there.' };
  try { await service.files.offerLocal(record.sourcePath, record.owner); push(); return { offered: [basename(record.sourcePath)] }; }
  catch (error) {
    // Only Orbit's own coded failures reach the UI; raw errno codes (EACCES, EPERM...) fold into FILE_IO.
    const raw = typeof error?.code === 'string' ? error.code : '';
    const code = /^(FILE_[A-Z_]+|UNAUTHENTICATED)$/.test(raw) ? raw : 'FILE_IO';
    return { error: 'The file could not be sent again.', code };
  }
});
// Renderer clipboard writes can silently no-op when the window lacks OS focus; the main-process clipboard always lands.
ipcMain.handle('orbit:copy-text', (_e, text) => { if (typeof text !== 'string' || !text || text.length > 64 * 1024) return false; electronClipboard.writeText(text); return true; });

async function offerToPhones(paths) {
  if (!service) return { error: 'Orbit is not running yet.' };
  const devices = service.credentials.list();
  if (!devices.length) return { error: 'Pair your phone first.' };
  const names = []; const errors = [];
  for (const path of paths) {
    const name = basename(path);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); }
    catch { errors.push({ name, code: 'FILE_NOT_FOUND' }); continue; } // the file vanished between picking and sending
    if (isDir) { errors.push({ name, code: 'IS_DIRECTORY' }); continue; }
    let offered = false;
    for (const device of devices) {
      try { await service.files.offerLocal(path, device.deviceId); offered = true; }
      catch (error) {
        const raw = typeof error?.code === 'string' ? error.code : '';
        errors.push({ name, code: /^(FILE_[A-Z_]+|UNAUTHENTICATED)$/.test(raw) ? raw : 'FILE_IO' });
      }
    }
    if (offered) names.push(name);
  }
  push();
  return { offered: names, errors };
}

ipcMain.handle('orbit:send-files', async (_e, paths) => {
  let list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p) : [];
  if (!list.length) {
    const picked = await dialog.showOpenDialog(win, { title: 'Send files to your phone', properties: ['openFile', 'multiSelections'] });
    if (picked.canceled) return { offered: [], errors: [] };
    list = picked.filePaths;
  }
  return offerToPhones(list.slice(0, 8));
});

function createWindow() {
  win = new BrowserWindow({ width: 1040, height: 700, minWidth: 860, minHeight: 580, show: false, title: 'Orbit',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B10' : '#F5F5F7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(join(here, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } }); // keep serving from the tray
}

// --- Desktop dictation hotkey: user-chosen toggle, OFF by default; capture starts and stops only from that shortcut. ---
const dictationHotkeyPath = () => join(app.getPath('userData'), 'dictation-hotkey.json');
const DICTATION_MODELS = ['tiny', 'base', 'small', 'turbo'];
function dictationHotkeyGet() {
  try { const c = JSON.parse(readFileSync(dictationHotkeyPath(), 'utf8')); return { enabled: Boolean(c.enabled), accelerator: typeof c.accelerator === 'string' && c.accelerator.length <= 64 ? c.accelerator : 'Control+Shift+D', model: DICTATION_MODELS.includes(c.model) ? c.model : 'tiny' }; }
  catch { return { enabled: false, accelerator: 'Control+Shift+D', model: 'tiny' }; }
}
function dictationHotkeySave(enabled, accelerator, model) {
  const prev = dictationHotkeyGet();
  const cfg = { enabled: Boolean(enabled), accelerator: typeof accelerator === 'string' && accelerator.trim().length >= 3 && accelerator.length <= 64 ? accelerator.trim() : 'Control+Shift+D', model: DICTATION_MODELS.includes(model) ? model : prev.model };
  writeFileSync(dictationHotkeyPath(), JSON.stringify(cfg), { mode: 0o600 });
  return cfg;
}
let localDictation; let localDictationEngine; let dictationWin;
function dictationStatePush(state) {
  tray?.setToolTip(state === 'recording' ? 'Orbit - recording dictation' : 'Orbit');
  dictationWin?.webContents.send('orbit:dictation-state', state);
}
let dictationDevice; let dictationProbe; let dictationActivator; let dictationInsertion; let dictationPending; let dictationSetupRef; let attachDictationRef; let dictationDataDir; // { text, target } awaiting the user's per-use choice
async function dictationReleaseDevice() { try { await dictationDevice?.releaseAll(); } catch { /* already released */ } dictationDevice = undefined; }
// The transcript is never typed automatically: it goes to the preview card, and the user copies it or confirms typing into the captured window.
function dictationPreview(text, target) {
  dictationPending = { text, target };
  if (Notification.isSupported()) new Notification({ title: 'Orbit dictation', body: 'Your dictated text is in Orbit. Nothing was sent anywhere - copy it, or confirm the window to insert it into.' }).show();
  dictationWin?.show();
  dictationWin?.webContents.send('orbit:dictation-preview', { text, targetLabel: target?.label });
}
async function dictationToggleKey() {
  if (!localDictation) return;
  if (localDictation.current === 'idle') {
    if (!localDictationEngine) {
      if (Notification.isSupported()) {
        const st = dictationSetupRef?.state; // { state, reason? } - a failed/cancelled setup never finishes on its own; pressing the hotkey is user intent, so retry the download right away (same path as the phone's Retry) and say what is happening
        let body = 'The dictation engine is still setting up. Try again in a minute.';
        if (st?.state === 'failed') {
          body = (st?.reason === 'cancelled' ? 'Dictation setup was cancelled. ' : 'Dictation setup did not finish. ')
            + 'Retrying the one-time download now - try dictating again when it completes.';
          void dictationSetupRef?.start(true);
        }
        new Notification({ title: 'Orbit dictation', body }).show();
      }
      return;
    }
    if (process.env.ORBIT_DICTATION_FAKE_CLIP) {
      // TEST HOOK ONLY - injected audio, NOT microphone capture. When this env var names a raw s16le 16 kHz mono PCM file,
      // one shortcut press runs the whole toggle through with that fixed clip, so the X11 flow (focus capture, transcription,
      // preview card, allowlisted confirmed paste) can be exercised without microphone hardware. Everything after the capture
      // step is the real path; any proof made this way is proof with INJECTED audio and says nothing about mic capture.
      console.log('DICTATION: ORBIT_DICTATION_FAKE_CLIP set - INJECTED audio test hook, NOT microphone capture');
      const raw = readFileSync(process.env.ORBIT_DICTATION_FAKE_CLIP);
      const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
      await localDictation.toggle(async () => undefined); // start: captures the focused window target
      await localDictation.toggle(async () => pcm);       // stop: injected clip instead of renderer mic audio
      return;
    }
    await localDictation.toggle(async () => undefined); // start: capture runs in the renderer
    dictationWin?.webContents.send('orbit:dictation-capture', 'start');
  } else {
    dictationWin?.webContents.send('orbit:dictation-capture', 'stop');
  }
}
function dictationHotkeyApply(cfg) {
  globalShortcut.unregisterAll();
  if (!cfg.enabled) return;
  try {
    if (!globalShortcut.register(cfg.accelerator, () => { void dictationToggleKey(); })) throw new Error('accelerator unavailable');
  } catch (e) { console.error('DICTATION: hotkey registration failed -', String(e?.message ?? e)); }
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(here, '..', 'build', 'tray.png')));
  tray.setToolTip('Orbit');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Orbit', click: () => (win.show(), win.focus()) },
    { label: 'Send files to phone…', click: async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Send files to your phone', properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return;
      const out = await offerToPhones(r.filePaths.slice(0, 8));
      const failed = out.error || (out.errors && out.errors.length);
      // The window is usually hidden when the tray is used, so the result must reach the user here.
      if (Notification.isSupported()) new Notification({ title: 'Orbit', body: failed
        ? (out.error || 'Could not send ' + out.errors.map(e => e.name).join(', ') + ' - Orbit is open with the reason.')
        : 'Waiting for your phone: ' + out.offered.join(', ') }).show();
      if (failed) { win.show(); win.focus(); } // the Files tab carries the plain-words reason
    } },
    { type: 'separator' }, { label: 'Quit Orbit', click: () => app.quit() }]));
  tray.on('click', () => (win.show(), win.focus()));
}

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', e => { localDictation?.cancel(); globalShortcut.unregisterAll(); if (service) { e.preventDefault(); const s = service; service = undefined; console.log('QUIT: stopping'); s.stop().then(() => console.log('QUIT: stopped'), er => console.log('QUIT: stop err ' + er)).finally(() => app.exit(0)); } });
nativeTheme.on('updated', push);
setInterval(push, 2000);

// Wi-Fi changes (new network, hotspot, VPN on/off) change the only address the phone can reach, so follow them.
// Skipped when the address is forced with ORBIT_HOST.
let switching = false;
setInterval(async () => {
  if (switching || quitting || process.env.ORBIT_HOST || state.phase === 'starting') return;
  const next = pickLanAddress(undefined, await defaultRouteAddress());
  if (next === state.host || (!next && state.phase === 'offline')) return;
  switching = true;
  try {
    if (service) { const old = service; service = undefined; pairingUntil = 0; clearTimeout(pairingTimer); await old.stop(); }
    await boot();
  } finally { switching = false; push(); }
}, 5000);

if (process.env.ORBIT_DARK) nativeTheme.themeSource = 'dark';
if (gotLock) app.whenReady().then(async () => {
await boot();
createWindow();
dictationWin = win;
createTray();
// Used by CI to smoke-test the packaged window: renders one frame to a PNG and exits.
if (process.env.ORBIT_QUIT_TEST) { setTimeout(() => { console.log('QUIT: calling app.quit()'); app.quit(); }, 3000); }
if (process.env.ORBIT_SMOKE_SHOT) {
  console.log('SMOKE: waiting for window, phase=' + state.phase);
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const { writeFileSync } = await import('node:fs');
    if (!process.env.ORBIT_SMOKE_TAB) await win.webContents.executeJavaScript("document.getElementById('pair').click()");
    if (process.env.ORBIT_SMOKE_TAB) await win.webContents.executeJavaScript(`document.querySelector('.nav[data-tab="${process.env.ORBIT_SMOKE_TAB}"]').click()`);
    if (process.env.ORBIT_SMOKE_DICTATION_PREVIEW) win.webContents.send('orbit:dictation-preview', { text: 'This is where your dictated text appears. Nothing was sent anywhere automatically - copy it, or confirm the window to insert it into.', targetLabel: process.env.ORBIT_SMOKE_DICTATION_PREVIEW === 'target' ? 'Editor - notes.txt' : undefined });
    await new Promise(r => setTimeout(r, 800));
    writeFileSync(process.env.ORBIT_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
    console.log('SMOKE: frame written'); app.exit(0);
  }, 1200));
  setTimeout(() => { console.log('SMOKE: timed out before a frame was captured, state=' + JSON.stringify(state)); app.exit(2); }, 90000);
}
});
