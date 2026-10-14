// Orbit Desktop shell: a tray + window around the existing service. Depends on Electron and the compiled service in ../dist.
// Runs the service in-process, shows a pairing QR only when the user asks, and never exposes the service to the page except through preload.
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import QRCode from 'qrcode';

const here = dirname(fileURLToPath(import.meta.url));
const { startDesktop } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'desktop-service.js')).href);
const { pickLanAddress } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'lan-address.js')).href);
const { DEFAULT_PORT } = await import(pathToFileURL(join(here, '..', 'dist', 'src', 'config.js')).href);
const { hostname } = await import('node:os');

if (!app.requestSingleInstanceLock()) app.quit();

let win; let tray; let service; let pairingTimer; let pairingUntil = 0; let state = { phase: 'starting' };
let quitting = false;

async function boot() {
  const host = process.env.ORBIT_HOST || pickLanAddress();
  if (!host) { state = { phase: 'offline' }; return; }
  try {
    service = await startDesktop({ directory: join(app.getPath('userData'), 'orbit-data'), host, port: DEFAULT_PORT,
      displayName: hostname().slice(0, 64) });
    state = { phase: 'running', host };
  } catch (error) {
    state = { phase: 'error', message: String(error?.message ?? error).slice(0, 200) };
  }
}

const snapshot = () => ({
  ...state, pairingUntil: pairingUntil > Date.now() ? pairingUntil : 0, dark: nativeTheme.shouldUseDarkColors,
  devices: service ? service.credentials.list() : [],
  activity: service ? service.log.snapshot().slice(-40).reverse() : [],
});
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('orbit:state', snapshot()); };

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

function createWindow() {
  win = new BrowserWindow({ width: 980, height: 660, minWidth: 820, minHeight: 560, show: false, title: 'Orbit',
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
    { type: 'separator' }, { label: 'Quit Orbit', click: () => app.quit() }]));
  tray.on('click', () => (win.show(), win.focus()));
}

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', e => { if (service) { e.preventDefault(); const s = service; service = undefined; s.stop().finally(() => app.quit()); } });
nativeTheme.on('updated', push);
setInterval(push, 2000);

app.whenReady().then(async () => {
await boot();
createWindow();
createTray();
// Used by CI to smoke-test the packaged window: renders one frame to a PNG and exits.
if (process.env.ORBIT_SMOKE_SHOT) {
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const { writeFileSync } = await import('node:fs');
    await win.webContents.executeJavaScript("document.getElementById('pair').click()");
    await new Promise(r => setTimeout(r, 800));
    writeFileSync(process.env.ORBIT_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
    quitting = true; app.quit();
  }, 1200));
}
});
