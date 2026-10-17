// Orbit Desktop shell: a tray + window around the existing service. Depends on Electron and the compiled service in ../dist.
// Runs the service in-process, shows a pairing QR only when the user asks, and never exposes the service to the page except through preload.
import { app, BrowserWindow, Tray, Menu, Notification, clipboard as electronClipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, basename } from 'node:path';
import QRCode from 'qrcode';

const here = dirname(fileURLToPath(import.meta.url));
const { startDesktop } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'desktop-service.js')).href);
const { pickLanAddress, defaultRouteAddress } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'lan-address.js')).href);
const { DEFAULT_PORT } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'config.js')).href);
const { createClipboard } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'os-integration', 'create-clipboard.js')).href);
const { WindowsInputDevice } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'os-integration', 'input-device.windows.js')).href);
const { hostname } = await import('node:os');

// Chromium's disk caches are useless for a local UI and fail with "Access is denied" when a previous
// instance still holds them (or the profile sits in a synced folder), so keep them off and in a private folder.
app.setName('Orbit');
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0); // a second launch only focuses the first window (see 'second-instance')

let win; let tray; let service; let pairingTimer; let pairingUntil = 0; let state = { phase: 'starting' };
let quitting = false;
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
    service = await startDesktop({ directory: join(app.getPath('userData'), 'orbit-data'), host, port: DEFAULT_PORT,
      displayName: hostname().slice(0, 64), ...(remoteInput ? { input: remoteInput } : {}) });
    state = { phase: 'running', host, port: DEFAULT_PORT };
  } catch (error) {
    state = { phase: 'error', message: String(error?.message ?? error).slice(0, 200) };
  }
}

function fileRows() {
  if (!service) return [];
  const rows = [];
  for (const record of service.files.store.records.values()) {
    const m = record.manifest;
    const row = { id: m.transferId, name: m.name, size: m.sizeBytes, direction: m.direction, state: record.state,
      progress: m.sizeBytes ? Math.min(1, record.nextOffset / m.sizeBytes) : (record.state === 'completed' ? 1 : 0),
      updatedAt: record.updatedAt, device: record.owner, error: record.error };
    if (record.state === 'completed' && m.direction === 'to-desktop') row.path = service.files.store.paths(record).destination;
    rows.push(row);
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, 100);
}

function notifyNewTransfers(rows) {
  if (!Notification.isSupported()) return;
  const fresh = [];
  for (const row of rows) {
    const done = ['completed', 'cancelled', 'failed', 'expired'].includes(row.state);
    if (!done) continue;
    if (!seenTerminal.has(row.id)) { seenTerminal.add(row.id); if (seeded) fresh.push(row); }
  }
  seeded = true;
  for (const row of fresh) {
    if (row.state === 'completed' && row.direction === 'to-desktop') {
      const n = new Notification({ title: 'File received', body: `${row.name} is on this computer.`, silent: false });
      n.on('click', () => { if (row.path) shell.showItemInFolder(row.path); win?.show(); });
      n.show();
    } else if (row.state === 'completed' && row.direction === 'to-client') {
      new Notification({ title: 'File delivered', body: `Your phone received ${row.name}.` }).show();
    } else if (row.state === 'failed' && row.direction === 'to-desktop') {
      new Notification({ title: 'File transfer failed', body: `${row.name} could not be received.` }).show();
    }
  }
}

// PC-side approval for phone remote control: a focused native dialog, default Deny, 30s timeout.
const electronApproval = { verify: async (message, context) => {
  if (!message.type.startsWith('input.')) return false;
  if (!win || win.isDestroyed()) return false;
  const device = String(context?.session?.deviceId ?? 'unknown').slice(0, 8);
  win.show(); win.focus();
  const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Orbit',
    message: 'Allow remote control?',
    detail: `Your phone (device ${device}) wants to move the mouse and type on this computer.\n\nChoose Deny unless you just started this on your phone.`,
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
  };
};
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('orbit:state', snapshot()); };

// The page only ever acts on paths that belong to a known transfer record, never on text it typed itself.
function knownPath(candidate) {
  if (typeof candidate !== 'string' || !service) return undefined;
  for (const record of service.files.store.records.values()) {
    if (record.state === 'completed' && record.manifest.direction === 'to-desktop'
      && service.files.store.paths(record).destination === candidate) return candidate;
    if (record.manifest.direction === 'to-client' && record.sourcePath === candidate) return candidate;
  }
  return undefined;
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
