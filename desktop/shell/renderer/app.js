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
  return { state: async () => { const th = new URLSearchParams(location.search).get('theme'); if (th) s.dark = th !== 'light'; return s; }, onState() {}, pair: async () => { const expiresAt = Date.now() + 120000; s.pairingUntil = expiresAt; return { svg: '<svg viewBox="0 0 10 10"><path d="M1 1h3v3H1zM6 1h3v3H6zM1 6h3v3H1zM5 5h1v1H5zM7 6h2v1H7zM6 8h1v1H6z"/></svg>', expiresAt }; }, cancelPair: async () => { s.pairingUntil = 0; }, revoke: async () => true, retry: async () => {}, loginItem: async () => false, copyText: async () => true, agentSave: async () => ({ ok: true }), agentClear: async () => ({ ok: true }), agentTest: async () => ({ status: 'ok' }),
    clipboardRead: async () => ({ kind: 'text', text: 'https://github.com/mananbharti/orbit' }), clipboardWrite: async () => true,
    openFile: async () => true, revealFile: async () => true, copyPath: async () => true, sendFiles: async () => ({ offered: ['orbit-logo.png'], errors: [] }), sendPaths: async () => ({ offered: [], errors: [] }), openInbox: async () => true, pathForFile: f => f.name, retryTransfer: async () => ({ offered: ['orbit-logo.png'] }),
    dictationGet: async () => ({ enabled: false, accelerator: 'Control+Shift+D', model: 'tiny', engine: true, suggested: null }), dictationSet: async () => ({ ok: true }), dictationSetModel: async () => ({ ok: true, downloaded: true }), dictationFinish: async () => ({ text: '' }), dictationTypeNow: async () => ({ ok: true }), fastDetect: async () => ({ error: 'No Ollama or LM Studio server detected on this computer' }),
    onDictationCapture() {}, onDictationState() {}, onDictationPreview() {} };
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
  else if (r.offered.length) { el.textContent = 'Waiting for phone: ' + r.offered.join(', '); el.className = 'send-result'; toast('Waiting for your phone to accept'); }
  if (r.errors && r.errors.length) { el.textContent = r.errors.join(' · '); el.className = 'send-result err'; }
};
$('open-inbox').onclick = () => api.openInbox();
$('ext-copy-port').onclick = async () => { if (await api.copyText($('ext-port').textContent)) toast('Port copied'); };
$('ext-copy-token').onclick = async () => { if (await api.copyText($('ext-token').textContent)) toast('Token copied'); };

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
  else if (r.offered.length) { el.textContent = 'Waiting for phone: ' + r.offered.join(', '); el.className = 'send-result'; toast('Waiting for your phone to accept'); }
  if (r.errors && r.errors.length) { el.textContent = r.errors.join(' · '); el.className = 'send-result err'; }
});

let clipTimer;
const CLIP_MESSAGES = {
  empty: 'Nothing to show - the clipboard holds no text right now.',
  unavailable: 'Clipboard is not available on this computer.',
  unsupported: 'The clipboard holds content Orbit cannot read as text.',
  oversized: 'The clipboard item is too large to show.',
  sensitive: 'The clipboard holds a private item from a password manager. Orbit never shows or syncs it.'
};
async function readClipboard() {
  const body = $('clip-body');
  const r = await api.clipboardRead();
  if (r.kind === 'text') { body.textContent = r.text; body.classList.remove('muted'); }
  else { body.textContent = CLIP_MESSAGES[r.kind] || CLIP_MESSAGES.unavailable; body.classList.add('muted'); }
  $('clip-copy').hidden = r.kind !== 'text';
}
$('clip-refresh').onclick = readClipboard;
$('clip-copy').onclick = async () => {
  const r = await api.clipboardRead();
  if (r.kind === 'text') { await api.clipboardWrite(r.text); toast('Copied'); }
};
setInterval(() => { if ($('clipboard').classList.contains('on')) readClipboard(); }, 2000);

const EVT_LABELS = { 'session.opened': 'Phone connected', 'session.closed': 'Phone disconnected', 'clipboard.sync': 'Clipboard synced', 'clipboard.changed': 'Clipboard synced', 'clipboard.ignored': 'Clipboard skipped', 'clipboard.conflict': 'Clipboard conflict avoided', 'file.state': 'File transfer updated', 'file.offered': 'File offered', 'pairing.opened': 'Pairing opened', 'pairing.completed': 'Phone paired', 'pairing.failed': 'Pairing failed', 'system.mode': 'Display mode changed', 'input.session': 'Remote control session', 'app.launch': 'App launched', 'agent.task': 'Agent task', 'discovery.error': 'Discovery issue', 'session.issued': 'Phone connected', 'session.refreshed': 'Session refreshed', 'connection.opened': 'Connection opened', 'connection.closed': 'Connection closed', 'connection.timeout': 'Connection timed out', 'authentication.rejected': 'Authentication rejected', 'pairing.revoked': 'Device removed', 'clipboard.unavailable': 'Clipboard unavailable', 'service.started': 'Service started', 'service.stopped': 'Service stopped', 'service.error': 'Service problem', 'message.rejected': 'Request blocked', 'command.completed': 'Command finished' };
const evtLabel = e => { const raw = EVT_LABELS[e.eventType] || e.eventType.replace(/\./g, ' '); return raw.charAt(0).toUpperCase() + raw.slice(1); };
const TRANSFER_LABEL = { offered: 'Waiting for phone', transferring: 'Transferring', paused: 'Paused', verifying: 'Verifying', completed: 'Done', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired' };
const FILE_ERROR_LABEL = { FILE_IO: 'the file could not be read', FILE_BYTES: 'the file could not be read', FILE_INTEGRITY: 'the copy failed a safety check', FILE_SOURCE_CHANGED: 'the file changed while sending', FILE_QUOTA: 'the phone was busy with another transfer', FILE_NOT_FOUND: 'the file was not found' };
function fileErrorLabel(code) { return FILE_ERROR_LABEL[code] || 'the transfer broke mid-way'; }

function transferRow(f, actions) {
  const cls = f.state === 'completed' ? 'done' : f.state === 'failed' ? 'fail' : '';
  return '<div class="transfer">' + fileIcon(f.name) +
    '<div class="tinfo"><div class="tname">' + esc(f.name) + '</div><div class="tsub">' + fmtSize(f.size) + ' · ' + TRANSFER_LABEL[f.state] + (f.state === 'failed' && f.error ? ' - ' + fileErrorLabel(f.error) : '') + ' · ' + ago(f.updatedAt) + '</div></div>' +
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
  $('qrbox').classList.toggle('live', Boolean(qrSvg));
  $('pair').hidden = open || !ok; $('cancel').hidden = !open;
  if (!ok) { $('pair').hidden = false; $('pair').textContent = 'Try again'; $('pair').onclick = () => api.retry(); } else { $('pair').textContent = 'Show pairing code'; $('pair').onclick = async () => { const r = await api.pair(); if (r.svg) { qrSvg = r.svg; render(await api.state()); } }; }
  $('hero-msg').textContent = open ? 'Scan with Orbit on your phone. This code works once.' : (s.devices.length ? 'Computer name: ' + s.pcName : 'Codes work once and expire after two minutes.');
  $('meta').textContent = s.devices.length + (s.devices.length === 1 ? ' device paired' : ' devices paired');

  // Agent tasks (Hermes gateway)
  if (s.agent) {
    $('agent-dot').className = 'dot ' + (s.agent.active ? 'ok' : '');
    $('agent-status').textContent = !s.agent.configured ? 'Off. Connect a local Hermes gateway to let your phone hand tasks to an AI agent here.'
      : !s.agent.active ? 'Saved, starting with the service...'
      : s.agent.gateway === 'ok' ? 'On. Your phone can hand tasks to the agent on this computer.'
      : s.agent.gateway === 'unauthorized' ? 'The gateway rejected the saved key. Check API_SERVER_KEY and save again.'
      : s.agent.gateway === 'unreachable' ? 'The gateway is not answering. Start it with: hermes gateway'
      : 'On. Your phone can hand tasks to the agent on this computer.';
    if (s.agent.fastModel) $('agent-status').textContent += ` Answer-only on: your phone can ask ${s.agent.fastModel.model} for text-only answers.`;
    if (s.agent.active && s.agent.laya !== 'unknown') $('agent-status').textContent += s.agent.laya === 'found'
      ? ' Fast layer on: a local Laya decision model triages new tasks.'
      : ' Fast layer idle: no Laya decision model answering, so new tasks are not triaged. Setup: docs/laya.md';
    $('agent-form').hidden = false;
    $('agent-clear').hidden = !s.agent.configured;
    $('agent-hint').textContent = s.agent.secureStorage ? 'The key is stored only in this computer\'s encrypted system storage.' : 'Secure storage is not available on this system, so a key cannot be saved safely here.';
    $('agent-save').disabled = !s.agent.secureStorage;
  }

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
  $('sent-list').innerHTML = sent.length ? sent.map(f => {
    const actions = f.retryable ? '<div class="actions"><button class="link" data-retry="' + esc(f.id) + '">Retry</button></div>' : '';
    return transferRow(f, actions);
  }).join('') : '<div class="empty">Nothing sent yet. Drop files above.</div>';
  document.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
    const r = await api.retryTransfer(b.dataset.retry);
    if (r && r.error) { toast(r.error); return; }
    toast('Offered to your phone again');
    render(await api.state());
  });
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
$('agent-save').onclick = async () => {
  const key = $('agent-key').value.trim();
  if (!key) { toast('Paste the Hermes API key first'); return; }
  $('agent-save').disabled = true;
  const pick = $('agent-fast').hidden || !$('agent-fast').value ? undefined : fastPicks[Number($('agent-fast').value)];
  const r = await api.agentSave(key, $('agent-url').value.trim(), $('agent-laya').value.trim(), pick);
  $('agent-save').disabled = false;
  if (r.error) toast(r.error); else { $('agent-key').value = ''; toast('Agent settings saved'); }
  render(await api.state());
};
$('agent-clear').onclick = async () => { await api.agentClear(); toast('Agent disconnected'); render(await api.state()); };
let fastPicks = [];
$('agent-detect').onclick = async () => {
  $('agent-detect').disabled = true; $('agent-detect').textContent = 'Detecting...';
  const r = await api.fastDetect();
  $('agent-detect').disabled = false; $('agent-detect').textContent = 'Detect models';
  if (r.error) { toast(r.error); return; }
  fastPicks = r.models.map(m => ({ kind: r.kind, baseUrl: r.baseUrl, model: m }));
  $('agent-fast').innerHTML = '<option value="">Fast answers off</option>' + fastPicks.map((p, i) => `<option value="${i}">${esc(p.model)} (${p.kind === 'ollama' ? 'Ollama' : 'LM Studio'})</option>`).join('');
  $('agent-fast').hidden = false;
  toast(`${r.models.length} model${r.models.length === 1 ? '' : 's'} found. Pick one for answer-only tasks, or leave off.`);
};
$('agent-test').onclick = async () => {
  const key = $('agent-key').value.trim();
  if (!key) { toast('Paste the Hermes API key first'); return; }
  $('agent-test').disabled = true; $('agent-test').textContent = 'Testing...';
  const r = await api.agentTest(key, $('agent-url').value.trim());
  $('agent-test').disabled = false; $('agent-test').textContent = 'Test';
  toast(r.status === 'ok' ? 'Connected to the gateway. Save to turn the agent on.'
    : r.status === 'unauthorized' ? 'The gateway rejected that key.'
    : r.status === 'unreachable' ? 'No answer. Start the gateway first: hermes gateway'
    : (r.error || 'Could not test the connection.'));
};
api.state().then(render); api.onState(render);

// --- Dictation hotkey: capture runs here (mic lives in the renderer); the main process owns the toggle, transcription and insertion. ---
let dicStream, dicCtx, dicNode, dicChunks = [], dicCapTimer, dicKey = 'the shortcut';
function dictationStatus(text) { const el = $('dictation-status'); if (el) el.textContent = text; }
let dicBannerTimer; // error/info banners auto-hide; a token keeps a stale timer from hiding a newer banner
function dictationBannerShow(text, mode, autoHideMs) {
  const b = $('dictation-banner'); if (!b) return;
  clearTimeout(dicBannerTimer);
  b.textContent = text;
  b.classList.remove('info', 'err'); if (mode) b.classList.add(mode);
  b.classList.add('on');
  if (autoHideMs) { const shown = text; dicBannerTimer = setTimeout(() => { if (b.textContent === shown) b.classList.remove('on', 'info', 'err'); }, autoHideMs); }
}
function dictationBannerHide() { clearTimeout(dicBannerTimer); const b = $('dictation-banner'); if (b) b.classList.remove('on', 'info', 'err'); }
function dictationEngineLine(cfg) { // honest setup state: 'setting up' only while a download is actually running or about to
  if (cfg.engine) return 'Dictation engine: ready';
  const s = cfg.setup && cfg.setup.state;
  if (s === 'downloading') return 'Dictation engine: downloading (one-time)';
  if (s === 'failed') return 'Dictation engine: download failed - re-save the hotkey or switch models to retry';
  return 'Dictation engine: setting up (one-time download)';
}
let dicSetupPoll;
function dictationEngineWatch(cfg) { // keeps the status line honest while a one-time download finishes in the background
  if (dicSetupPoll) { clearInterval(dicSetupPoll); dicSetupPoll = undefined; }
  if (!cfg || cfg.engine || !cfg.setup || cfg.setup.state !== 'downloading') return;
  dicSetupPoll = setInterval(async () => {
    try {
      const c = await api.dictationGet();
      dictationStatus(dictationEngineLine(c));
      if (c.engine || !c.setup || c.setup.state !== 'downloading') { clearInterval(dicSetupPoll); dicSetupPoll = undefined; }
    } catch { clearInterval(dicSetupPoll); dicSetupPoll = undefined; }
  }, 2000);
}
function dictationCleanupMic() { // every exit path releases the mic: tracks stopped, context closed, chunks zeroed
  clearTimeout(dicCapTimer);
  try { dicNode && dicNode.disconnect(); } catch { /* already stopped */ }
  if (dicCtx) { const c = dicCtx; dicCtx = undefined; c.close().catch(() => {}); }
  if (dicStream) { dicStream.getTracks().forEach(t => t.stop()); dicStream = undefined; }
  dicNode = undefined;
  dicChunks.forEach(c => c.fill(0)); dicChunks = [];
  dictationBannerHide();
}
async function dictationStartCapture() {
  try {
    dicChunks = [];
    dicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    dicCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = dicCtx.createMediaStreamSource(dicStream);
    dicNode = dicCtx.createScriptProcessor(4096, 1, 1);
    const ratio = dicCtx.sampleRate / 16000;
    let pos = 0; // fractional read cursor, carried across buffers so phase stays correct
    dicNode.onaudioprocess = e => {
      const input = e.inputBuffer.getChannelData(0);
      const out = [];
      while (pos + 1 <= input.length) { out.push(input[Math.floor(pos)]); pos += ratio; }
      pos -= input.length;
      const pcm = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767)));
      dicChunks.push(pcm);
    };
    src.connect(dicNode); dicNode.connect(dicCtx.destination);
    dictationStatus('Recording... press ' + dicKey + ' again to stop');
    dictationBannerShow('\u25CF Recording - press ' + dicKey + ' again to stop');
    dicCapTimer = setTimeout(() => dictationStopCapture(), 60000);
  } catch (e) {
    dictationCleanupMic(); // a partial setup must never leave the mic open
    const msg = 'Microphone unavailable: ' + (e && e.message ? e.message : e);
    dictationStatus(msg);
    dictationBannerShow(msg, 'err', 6000); // the status line lives on the Settings tab; the failure must be visible wherever the user is
  }
}
async function dictationStopCapture() {
  clearTimeout(dicCapTimer);
  const chunks = dicChunks;
  try { dicNode && dicNode.disconnect(); } catch { /* already stopped */ }
  if (dicCtx) { const c = dicCtx; dicCtx = undefined; await c.close().catch(() => {}); }
  if (dicStream) { dicStream.getTracks().forEach(t => t.stop()); dicStream = undefined; }
  dicNode = undefined; dicChunks = [];
  dictationBannerHide();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total); let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; c.fill(0); }
  dictationStatus('Transcribing...');
  try { await api.dictationFinish(pcm.buffer); } finally { pcm.fill(0); }
}
function dictationAbortCapture() { // shortcut disabled or app quitting: drop everything, send nothing
  dictationCleanupMic();
  dictationStatus('Dictation engine: ready');
}
if (api.onDictationCapture) api.onDictationCapture(action => { if (action === 'start') void dictationStartCapture(); else if (action === 'abort') dictationAbortCapture(); else void dictationStopCapture(); });
if (api.onDictationState) api.onDictationState(st => {
  if (st === 'idle') { dictationStatus('Dictation engine: ready'); dictationBannerHide(); }
  if (st === 'working') { dictationStatus('Transcribing...'); dictationBannerShow('Transcribing...', 'info'); } // transcription can take many seconds; keep it visible on every tab
});
if (api.onDictationPreview) api.onDictationPreview(payload => {
  const card = $('dictation-preview-card'); if (!card) return;
  if (payload.hide) { card.classList.remove('on'); return; }
  dictationBannerHide();
  $('dictation-preview-why').textContent = 'Nothing was sent anywhere. Copy the text, or confirm the window to insert it into.';
  $('dictation-preview-text').textContent = payload.text;
  const typeBtn = $('dictation-preview-type');
  if (typeBtn) { if (payload.targetLabel) { typeBtn.textContent = 'Insert into ' + payload.targetLabel; typeBtn.classList.add('on'); } else { typeBtn.classList.remove('on'); } }
  card.classList.add('on');
});
if ($('dictation-preview-type')) $('dictation-preview-type').onclick = async () => {
  const r = await api.dictationTypeNow();
  if (r.ok) { $('dictation-preview-card').classList.remove('on'); $('dictation-preview-text').textContent = ''; toast(r.via === 'paste' ? 'Paste sent to the window' : 'Typed into the window'); }
  else toast(r.reason || 'Could not insert into that window');
};
if ($('dictation-preview-copy')) $('dictation-preview-copy').onclick = async () => { if (await api.copyText($('dictation-preview-text').textContent)) toast('Copied'); };
if ($('dictation-preview-dismiss')) $('dictation-preview-dismiss').onclick = () => { $('dictation-preview-card').classList.remove('on'); $('dictation-preview-text').textContent = ''; };
if (api.dictationGet) void (async () => {
  const cfg = await api.dictationGet();
  if ($('dictation-enable')) $('dictation-enable').checked = cfg.enabled;
  if ($('dictation-key')) $('dictation-key').value = cfg.accelerator;
  dicKey = cfg.accelerator || 'the shortcut';
  const modelSel = $('dictation-model');
  if (modelSel && cfg.model) {
    modelSel.value = cfg.model;
    if (cfg.suggested && cfg.suggested !== cfg.model) dictationStatus(dictationEngineLine(cfg) + ' - suggested for this computer: ' + cfg.suggested);
    else dictationStatus(dictationEngineLine(cfg));
    dictationEngineWatch(cfg);
    modelSel.onchange = async () => {
      dictationStatus('Dictation engine: preparing ' + modelSel.value + ' model...');
      const r = await api.dictationSetModel(modelSel.value);
      dictationStatus('Dictation engine: ' + (r.ok ? (r.downloaded ? 'ready' : 'downloading ' + modelSel.value + ' (one-time)') : 'could not switch models'));
      if (r.ok && !r.downloaded) dictationEngineWatch(await api.dictationGet());
    };
  } else dictationStatus(dictationEngineLine(cfg));
  const save = $('dictation-save');
  if (save) save.onclick = async () => {
    const r = await api.dictationSet($('dictation-enable').checked, $('dictation-key').value.trim());
    if (r.ok) dicKey = $('dictation-key').value.trim() || dicKey;
    if (r.ok && $('dictation-enable').checked) { const cfg2 = await api.dictationGet(); dictationStatus(dictationEngineLine(cfg2)); dictationEngineWatch(cfg2); }
    toast(r.ok ? 'Dictation hotkey saved' : 'Could not save the hotkey');
  };
})();
