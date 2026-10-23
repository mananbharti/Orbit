// Orbit Desktop shell: a tray + window around the existing service. Depends on Electron and the compiled service in ../dist.
// Runs the service in-process, shows a pairing QR only when the user asks, and never exposes the service to the page except through preload.
import { app, BrowserWindow, Tray, Menu, Notification, clipboard as electronClipboard, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, basename } from 'node:path';
import QRCode from 'qrcode';
import { transferRows, freshTerminalTransfers, notificationFor, knownPath as knownTransferPath } from './logic.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { startDesktop } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'desktop-service.js')).href);
const { pickLanAddress, defaultRouteAddress } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'lan-address.js')).href);
const { DEFAULT_PORT } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'config.js')).href);
const { createClipboard } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'os-integration', 'create-clipboard.js')).href);
const { WindowsInputDevice } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'os-integration', 'input-device.windows.js')).href);
const { hostname } = await import('node:os');
const { HermesRunner } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'agent', 'hermes-runner.js')).href);
const { loadAgentConfig, saveAgentConfig, clearAgentConfig, validateAgentConfig } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'agent-config.js')).href);

// Chromium's disk caches are useless for a local UI and fail with "Access is denied" when a previous
// instance still holds them (or the profile sits in a synced folder), so keep them off and in a private folder.
app.setName('Orbit');
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0); // a second launch only focuses the first window (see 'second-instance')

let win; let tray; let service; let pairingTimer; let pairingUntil = 0; let state = { phase: 'starting' };
let quitting = false; let restarting = false;
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
    const remoteInput = process.platform === 'win32'
      ? { createDevice: () => new WindowsInputDevice(), confirmation: electronApproval } : undefined;
    // Remote terminal: every session needs a Yes on a dialog shown at this PC (below), same as remote control.
    const terminal = process.platform === 'win32' ? { confirmation: electronApproval } : undefined;
    // Agent tasks: on when a Hermes gateway key is configured (Settings > Agent, or the env var for the CLI).
    const hermes = agentSettings();
    let agent;
    if (hermes) {
      try { agent = { runner: new HermesRunner({ apiKey: hermes.apiKey, ...(hermes.baseUrl ? { baseUrl: hermes.baseUrl } : {}) }) }; }
      catch (error) { console.error('AGENT: disabled -', String(error?.message ?? error)); }
    }
    service = await startDesktop({ directory: join(app.getPath('userData'), 'orbit-data'), host, port: DEFAULT_PORT,
      displayName: hostname().slice(0, 64), ...(remoteInput ? { input: remoteInput } : {}), ...(terminal ? { terminal } : {}), ...(agent ? { agent } : {}), onExtensionConnection: () => push() });
    state = { phase: 'running', host, port: DEFAULT_PORT };
  } catch (error) {
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
  const isInput = message.type.startsWith('input.');
  const isTerminal = message.type === 'terminal.begin';
  if (!isInput && !isTerminal) return false;
  if (!win || win.isDestroyed()) return false;
  const device = String(context?.session?.deviceId ?? 'unknown').slice(0, 8);
  win.show(); win.focus();
  const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Orbit',
    message: isTerminal ? 'Allow terminal access?' : 'Allow remote control?',
    detail: isTerminal
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

// The page only ever acts on paths that belong to a known transfer record, never on text it typed itself.
function knownPath(candidate) {
  if (!service) return undefined;
  return knownTransferPath(service.files.store.records.values(), (record) => service.files.store.paths(record).destination, candidate);
}

ipcMain.handle('orbit:state', () => snapshot());
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
ipcMain.handle('orbit:agent-save', async (_e, key, baseUrl) => {
  if (!safeStorage.isEncryptionAvailable()) return { error: 'Secure storage is not available on this system, so the key cannot be saved safely.' };
  let config;
  try { config = validateAgentConfig({ apiKey: key, baseUrl }); } catch (error) { return { error: String(error?.message ?? error) }; }
  saveAgentConfig(agentConfigPath(), config, agentEncrypt);
  await restartService();
  return { ok: true };
});
ipcMain.handle('orbit:agent-clear', async () => { clearAgentConfig(agentConfigPath()); await restartService(); return { ok: true }; });
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

async function offerToPhones(paths) {
  if (!service) return { error: 'Orbit is not running yet.' };
  const devices = service.credentials.list();
  if (!devices.length) return { error: 'Pair your phone first.' };
  const names = []; const errors = [];
  for (const path of paths) {
    let offered = false;
    for (const device of devices) {
      try { await service.files.offerLocal(path, device.deviceId); offered = true; }
      catch (error) { errors.push(`${basename(path)}: ${String(error?.message ?? error).slice(0, 120)}`); }
    }
    if (offered) names.push(basename(path));
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

function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(here, '..', 'build', 'tray.png')));
  tray.setToolTip('Orbit');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Orbit', click: () => (win.show(), win.focus()) },
    { label: 'Send files to phone…', click: async () => { const r = await dialog.showOpenDialog(win, { title: 'Send files to your phone', properties: ['openFile', 'multiSelections'] }); if (!r.canceled) await offerToPhones(r.filePaths.slice(0, 8)); } },
    { type: 'separator' }, { label: 'Quit Orbit', click: () => app.quit() }]));
  tray.on('click', () => (win.show(), win.focus()));
}

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', e => { if (service) { e.preventDefault(); const s = service; service = undefined; console.log('QUIT: stopping'); s.stop().then(() => console.log('QUIT: stopped'), er => console.log('QUIT: stop err ' + er)).finally(() => app.exit(0)); } });
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
createTray();
// Used by CI to smoke-test the packaged window: renders one frame to a PNG and exits.
if (process.env.ORBIT_QUIT_TEST) { setTimeout(() => { console.log('QUIT: calling app.quit()'); app.quit(); }, 3000); }
if (process.env.ORBIT_SMOKE_SHOT) {
  console.log('SMOKE: waiting for window, phase=' + state.phase);
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const { writeFileSync } = await import('node:fs');
    if (!process.env.ORBIT_SMOKE_TAB) await win.webContents.executeJavaScript("document.getElementById('pair').click()");
    if (process.env.ORBIT_SMOKE_TAB) await win.webContents.executeJavaScript(`document.querySelector('.nav[data-tab="${process.env.ORBIT_SMOKE_TAB}"]').click()`);
    await new Promise(r => setTimeout(r, 800));
    writeFileSync(process.env.ORBIT_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
    console.log('SMOKE: frame written'); app.exit(0);
  }, 1200));
  setTimeout(() => { console.log('SMOKE: timed out before a frame was captured, state=' + JSON.stringify(state)); app.exit(2); }, 90000);
}
});
