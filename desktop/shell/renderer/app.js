const $ = id => document.getElementById(id);
// Standalone preview (no Electron): show realistic sample data so the UI can be reviewed in a browser.
const api = window.orbit ?? (() => {
  let s = { phase: 'running', host: '192.168.1.23', pairingUntil: 0, devices: [{ deviceId: 'iphone-17-pro', scopes: 'all' }],
    activity: [{ timestamp: new Date().toISOString(), eventType: 'session.opened', outcome: 'success', severity: 'info' }, { timestamp: new Date().toISOString(), eventType: 'clipboard.sync', outcome: 'success', severity: 'info' }] };
  return { state: async () => s, onState() {}, pair: async () => ({ svg: '<svg viewBox="0 0 10 10"><path d="M1 1h3v3H1zM6 1h3v3H6zM1 6h3v3H1zM5 5h1v1H5zM7 6h2v1H7zM6 8h1v1H6z"/></svg>', expiresAt: Date.now() + 120000 }), cancelPair: async () => {}, revoke: async () => true, retry: async () => {}, loginItem: async () => false };
})();
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let qrSvg = ''; let current;
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.nav,.tab').forEach(e => e.classList.remove('on'));
  b.classList.add('on'); $(b.dataset.tab).classList.add('on');
}));
$('pair').onclick = async () => { const r = await api.pair(); if (r.svg) { qrSvg = r.svg; render(await api.state()); } };
$('cancel').onclick = async () => { await api.cancelPair(); qrSvg = ''; render(await api.state()); };
$('login').onchange = e => api.loginItem(e.target.checked);
api.loginItem().then(v => { $('login').checked = !!v; });
const label = e => e.eventType.replace(/\./g, ' ');
function render(s) {
  current = s; const open = s.pairingUntil > Date.now(); if (!open) qrSvg = '';
  const ok = s.phase === 'running';
  $('dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('status-text').textContent = ok ? 'Ready on ' + s.host : s.phase === 'offline' ? 'No Wi-Fi' : s.phase === 'error' ? 'Problem starting' : 'Starting';
  $('title').textContent = !ok ? (s.phase === 'offline' ? 'Connect to Wi-Fi' : 'Orbit could not start') : s.devices.length ? 'You are all set' : 'Connect your phone';
  $('subtitle').textContent = s.phase === 'offline' ? 'Orbit needs the same Wi-Fi network as your phone. Join one, then try again.' : s.phase === 'error' ? (s.message ?? '') : 'Open Orbit on your phone, tap Pair, and scan the code. Both devices must be on the same Wi-Fi.';
  $('qrbox').innerHTML = qrSvg || '<div class="qr-empty">Pairing is closed</div>';
  $('pair').hidden = open || !ok; $('cancel').hidden = !open;
  if (!ok) { $('pair').hidden = false; $('pair').textContent = 'Try again'; $('pair').onclick = () => api.retry(); } else { $('pair').textContent = 'Show pairing code'; $('pair').onclick = async () => { const r = await api.pair(); if (r.svg) { qrSvg = r.svg; render(await api.state()); } }; }
  $('hero-msg').textContent = open ? 'Scan with Orbit on your phone. This code works once.' : 'Codes work once and expire after two minutes.';
  $('meta').textContent = s.devices.length + (s.devices.length === 1 ? ' device paired' : ' devices paired');
  $('device-list').innerHTML = s.devices.length ? s.devices.map(d => `<div class="row"><span><b>${esc(d.deviceId)}</b><small>${d.scopes === 'all' ? 'Full access' : esc(d.scopes.join(', '))}</small></span><button class="link" data-id="${esc(d.deviceId)}">Unpair</button></div>`).join('') : '<div class="empty">No paired devices yet.</div>';
  document.querySelectorAll('.link').forEach(b => b.onclick = async () => { if (confirm('Unpair this device? It stops working immediately.')) { await api.revoke(b.dataset.id); render(await api.state()); } });
  $('activity-list').innerHTML = s.activity.length ? s.activity.map(e => `<div class="row"><span><b>${esc(label(e))}</b><small>${new Date(e.timestamp).toLocaleTimeString()}</small></span><span class="badge ${e.outcome === 'failed' ? 'fail' : e.severity === 'warn' ? 'warn' : ''}">${esc(e.outcome ?? e.severity)}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>';
}
api.state().then(render); api.onState(render);
