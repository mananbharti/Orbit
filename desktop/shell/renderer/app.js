const $ = id => document.getElementById(id);
// Standalone preview (no Electron): show realistic sample data so the UI can be reviewed in a browser.
const api = window.orbit ?? (() => {
  let s = { phase: 'running', host: '192.168.1.23', port: 8765, pairingUntil: 0, dark: true, pcName: 'MANAN-OMEN',
    devices: [{ deviceId: 'iphone-17-pro', scopes: 'all' }],
    files: [
      { id: '1', name: 'Kaizen reel final.mp4', size: 48234496, direction: 'to-desktop', state: 'completed', progress: 1, updatedAt: Date.now() - 840000, device: 'iphone-17-pro', path: '/x' },
      { id: '2', name: 'notes.txt', size: 2048, direction: 'to-desktop', state: 'transferring', progress: .42, updatedAt: Date.now() - 60000, device: 'iphone-17-pro' },
      { id: '3', name: 'orbit-logo.png', size: 184320, direction: 'to-client', state: 'completed', progress: 1, updatedAt: Date.now() - 3600000, device: 'iphone-17-pro' }],
    activity: [{ timestamp: new Date().toISOString(), eventType: 'session.opened', outcome: 'success', severity: 'info' }, { timestamp: new Date().toISOString(), eventType: 'clipboard.sync', outcome: 'success', severity: 'info' }],
    browserExtension: { port: 17342, token: 'd2VsbC1kb25lLXlvdS1mb3VuZC10aGU' } };
  return { state: async () => { const th = new URLSearchParams(location.search).get('theme'); if (th) s.dark = th !== 'light'; return s; }, onState() {}, pair: async () => ({ svg: '<svg viewBox="0 0 10 10"><path d="M1 1h3v3H1zM6 1h3v3H6zM1 6h3v3H1zM5 5h1v1H5zM7 6h2v1H7zM6 8h1v1H6z"/></svg>', expiresAt: Date.now() + 120000 }), cancelPair: async () => {}, revoke: async () => true, retry: async () => {}, loginItem: async () => false,
    clipboardRead: async () => ({ kind: 'text', text: 'https://github.com/mananbharti/Orbit-1.0' }), clipboardWrite: async () => true,
    openFile: async () => true, revealFile: async () => true, copyPath: async () => true, sendFiles: async () => ({ offered: ['orbit-logo.png'], errors: [] }), sendPaths: async () => ({ offered: [], errors: [] }), openInbox: async () => true, pathForFile: f => f.name };
})();
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtSize = n => n < 1024 ? n + ' B' : n < 1024 ** 2 ? (n / 1024).toFixed(0) + ' KB' : n < 1024 ** 3 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024 ** 3).toFixed(2) + ' GB';
const ago = ts => { const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
const fileIcon = name => { const ext = (name.split('.').pop() || 'file').slice(0, 4); return '<span class="fi" data-ext="' + esc(ext.toLowerCase()) + '">' + esc(ext) + '</span>'; };
let qrSvg = ''; let toastTimer;
const toast = msg => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400); };

// Standalone preview helper: ?tab=settings opens that tab (used by headless screenshot checks; harmless in the app).
const wantTab = new URLSearchParams(location.search).get('tab');
if (!window.orbit && wantTab) {
  // Headless review: skip the entry fade so screenshots are deterministic
  // (a <style> tag would be blocked by the CSP, so flip a stylesheet selector).
  document.documentElement.dataset.preview = '1';
  setTimeout(() => document.querySelector('.nav[data-tab="' + wantTab + '"]')?.click(), 0);
}
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.nav,.tab').forEach(e => e.classList.remove('on'));
  b.classList.add('on'); $(b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'clipboard') readClipboard();
}));
const goTab = name => document.querySelector('.nav[data-tab="' + name + '"]').click();

$('pair').onclick = async () => { const r = await api.pair(); if (r.svg) { qrSvg = r.svg; render(await api.state()); } else if (r.error) toast(r.error); };
$('cancel').onclick = async () => { await api.cancelPair(); qrSvg = ''; render(await api.state()); };
$('login').onchange = e => api.loginItem(e.target.checked);
api.loginItem().then(v => { $('login').checked = !!v; });
$('quick-send').onclick = () => goTab('files');
$('quick-clipboard').onclick = () => goTab('clipboard');
$('choose-files').onclick = async () => {
  const r = await api.sendFiles();
  const el = $('send-result');
  if (r.error) { el.textContent = r.error; el.className = 'send-result err'; }
  else if (r.offered.length) { el.textContent = 'Sent: ' + r.offered.join(', '); el.className = 'send-result'; toast('Sending to your phone'); }
  if (r.errors && r.errors.length) { el.textContent = r.errors.join(' · '); el.className = 'send-result err'; }
};
$('open-inbox').onclick = () => api.openInbox();
$('ext-copy-port').onclick = () => { navigator.clipboard.writeText($('ext-port').textContent); toast('Port copied'); };
$('ext-copy-token').onclick = () => { navigator.clipboard.writeText($('ext-token').textContent); toast('Token copied'); };

// Drag and drop anywhere on the Files tab.
const dz = $('dropzone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', async e => {
  const paths = [...(e.dataTransfer.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await api.sendPaths(paths);
  const el = $('send-result');
  if (r.error) { el.textContent = r.error; el.className = 'send-result err'; }
  else if (r.offered.length) { el.textContent = 'Sent: ' + r.offered.join(', '); el.className = 'send-result'; toast('Sending to your phone'); }
  if (r.errors && r.errors.length) { el.textContent = r.errors.join(' · '); el.className = 'send-result err'; }
});

let clipTimer;
async function readClipboard() {
  const body = $('clip-body');
  const r = await api.clipboardRead();
  if (r.kind === 'text') { body.textContent = r.text; body.classList.remove('muted'); }
  else { body.textContent = r.kind === 'unavailable' ? 'Clipboard is not available on this computer.' : 'Nothing to show - the clipboard holds no text right now.'; body.classList.add('muted'); }
}
$('clip-refresh').onclick = readClipboard;
$('clip-copy').onclick = async () => {
  const r = await api.clipboardRead();
  if (r.kind === 'text') { await api.clipboardWrite(r.text); toast('Copied'); }
};
setInterval(() => { if ($('clipboard').classList.contains('on')) readClipboard(); }, 2000);

const EVT_LABELS = { 'session.opened': 'Phone connected', 'session.closed': 'Phone disconnected', 'clipboard.sync': 'Clipboard synced', 'clipboard.changed': 'Clipboard synced', 'clipboard.ignored': 'Clipboard skipped', 'clipboard.conflict': 'Clipboard conflict avoided', 'file.state': 'File transfer updated', 'file.offered': 'File offered', 'pairing.opened': 'Pairing opened', 'pairing.completed': 'Phone paired', 'pairing.failed': 'Pairing failed', 'system.mode': 'Display mode changed', 'input.session': 'Remote control session', 'app.launch': 'App launched', 'agent.task': 'Agent task', 'discovery.error': 'Discovery issue' };
const evtLabel = e => EVT_LABELS[e.eventType] || e.eventType.replace(/\./g, ' ');
const TRANSFER_LABEL = { offered: 'Waiting for phone', transferring: 'Transferring', paused: 'Paused', verifying: 'Verifying', completed: 'Done', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired' };

function transferRow(f, actions) {
  const cls = f.state === 'completed' ? 'done' : f.state === 'failed' ? 'fail' : '';
  return '<div class="transfer">' + fileIcon(f.name) +
    '<div class="tinfo"><div class="tname">' + esc(f.name) + '</div><div class="tsub">' + fmtSize(f.size) + ' · ' + TRANSFER_LABEL[f.state] + ' · ' + ago(f.updatedAt) + '</div></div>' +
    (['transferring', 'offered', 'verifying', 'paused'].includes(f.state) ? '<progress class="' + cls + '" max="1" value="' + f.progress + '"></progress>' : '') +
    (actions || '') + '</div>';
}

function render(s) {
  const open = s.pairingUntil > Date.now(); if (!open) qrSvg = '';
  document.documentElement.dataset.theme = s.dark ? 'dark' : 'light';
  const ok = s.phase === 'running';
  $('dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('status-text').textContent = ok ? 'Ready' : s.phase === 'offline' ? 'No Wi-Fi' : s.phase === 'error' ? 'Problem starting' : 'Starting';
  $('status-sub').textContent = ok ? (s.host + ':' + (s.port ?? 8765)) : '';
  $('title').textContent = !ok ? (s.phase === 'offline' ? 'Connect to Wi-Fi' : 'Orbit could not start') : s.devices.length ? 'You are all set' : 'Connect your phone';
  $('subtitle').textContent = s.phase === 'offline' ? 'Orbit needs the same Wi-Fi network as your phone. Join one, then try again.' : s.phase === 'error' ? (s.message ?? '') : 'Open Orbit on your phone, tap Pair, and scan the code. Both devices must be on the same Wi-Fi.';
  $('qrbox').innerHTML = qrSvg || '<div class="qr-empty">Pairing is closed</div>';
  $('pair').hidden = open || !ok; $('cancel').hidden = !open;
  if (!ok) { $('pair').hidden = false; $('pair').textContent = 'Try again'; $('pair').onclick = () => api.retry(); } else { $('pair').textContent = 'Show pairing code'; $('pair').onclick = async () => { const r = await api.pair(); if (r.svg) { qrSvg = r.svg; render(await api.state()); } }; }
  $('hero-msg').textContent = open ? 'Scan with Orbit on your phone. This code works once.' : (s.devices.length ? s.pcName + ' is reachable by your phone.' : 'Codes work once and expire after two minutes.');
  $('meta').textContent = s.devices.length + (s.devices.length === 1 ? ' device paired' : ' devices paired');

  // Browser extension
  if (s.browserExtension) {
    $('ext-card').hidden = false;
    $('ext-port').textContent = String(s.browserExtension.port);
    $('ext-token').textContent = s.browserExtension.token;
    $('ext-dot').className = 'dot ' + (s.browserExtension.connected ? 'ok' : '');
    $('ext-status').textContent = s.browserExtension.connected ? 'Connected. Your phone can see this browser\'s tabs.' : 'Not connected yet. Set it up below.';
  }

  // Files
  const files = s.files || [];
  const active = files.filter(f => ['offered', 'transferring', 'paused', 'verifying'].includes(f.state));
  $('active-transfers').innerHTML = active.length ? '<div class="card list">' + active.map(f => transferRow(f)).join('') + '</div>' : '';
  const received = files.filter(f => f.direction === 'to-desktop' && !active.includes(f));
  $('received-list').innerHTML = received.length ? received.map(f => {
    const actions = f.state === 'completed' && f.path ? '<div class="actions"><button class="link" data-act="open" data-p="' + esc(f.path) + '">Open</button><button class="link" data-act="reveal" data-p="' + esc(f.path) + '">Folder</button><button class="link" data-act="copy" data-p="' + esc(f.path) + '">Copy path</button></div>' : '';
    return transferRow(f, actions);
  }).join('') : '<div class="empty">Nothing received yet. Send something from your phone and it appears here.</div>';
  const sent = files.filter(f => f.direction === 'to-client' && !active.includes(f));
  $('sent-list').innerHTML = sent.length ? sent.map(f => transferRow(f)).join('') : '<div class="empty">Nothing sent yet. Drop files above.</div>';
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    if (b.dataset.act === 'open') await api.openFile(b.dataset.p);
    if (b.dataset.act === 'reveal') await api.revealFile(b.dataset.p);
    if (b.dataset.act === 'copy') { await api.copyPath(b.dataset.p); toast('Path copied'); }
  });

  // Devices
  $('device-list').innerHTML = s.devices.length ? s.devices.map(d => '<div class="row"><span><b>' + esc(d.deviceId) + '</b><small>' + (d.scopes === 'all' ? 'Full access' : esc((d.scopes || []).join(', '))) + '</small></span><button class="link" data-id="' + esc(d.deviceId) + '">Unpair</button></div>').join('') : '<div class="empty">No paired devices yet.</div>';
  document.querySelectorAll('#device-list .link').forEach(b => b.onclick = async () => { if (confirm('Unpair this device? It stops working immediately.')) { await api.revoke(b.dataset.id); render(await api.state()); } });

  // Activity
  $('activity-list').innerHTML = s.activity.length ? s.activity.map(e => '<div class="row"><span><b>' + esc(evtLabel(e)) + '</b><small>' + new Date(e.timestamp).toLocaleTimeString() + (e.deviceId ? ' · ' + esc(e.deviceId) : '') + '</small></span><span class="badge ' + (e.outcome === 'failed' ? 'fail' : e.severity === 'warn' ? 'warn' : 'ok') + '">' + esc(e.outcome ?? e.severity) + '</span></div>').join('') : '<div class="empty">Nothing yet.</div>';
}
api.state().then(render); api.onState(render);
