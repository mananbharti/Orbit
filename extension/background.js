/* Orbit browser bridge: connects to the Orbit app on this computer over loopback and answers tab commands. */
const RETRY_MS = [2000, 5000, 15000, 60000];

let socket;
let attempt = 0;

function settings() {
  return new Promise(resolve => chrome.storage.local.get(['port', 'token'], resolve));
}

async function setBadge(connected) {
  await chrome.action?.setBadgeBackgroundColor?.({ color: connected ? '#34c759' : '#8e8e93' });
  await chrome.action?.setBadgeText?.({ text: connected ? '' : 'off' });
}

function answer(message) {
  const reply = (ok, result, error) => {
    const body = { id: message.id, ok };
    if (ok) body.result = result; else body.error = error;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
  };
  try {
    switch (message.type) {
      case 'list':
        chrome.tabs.query({}, tabs => {
          const err = chrome.runtime.lastError;
          if (err) { reply(false, undefined, err.message); return; }
          reply(true, {
            tabs: (tabs || []).map(t => ({ id: t.id, title: t.title || '', url: t.url || '', active: !!t.active, windowId: t.windowId }))
          });
        });
        break;
      case 'open':
        chrome.tabs.create({ url: message.url }, tab => {
          const err = chrome.runtime.lastError;
          if (err || !tab) { reply(false, undefined, err ? err.message : 'tab was not created'); return; }
          reply(true, { id: tab.id });
        });
        break;
      case 'close':
        chrome.tabs.remove(message.tabId, () => {
          const err = chrome.runtime.lastError;
          if (err) reply(false, undefined, /No tab|not found/i.test(err.message) ? 'not found' : err.message);
          else reply(true, {});
        });
        break;
      case 'activate':
        chrome.tabs.update(message.tabId, { active: true }, tab => {
          const err = chrome.runtime.lastError;
          if (err) { reply(false, undefined, /No tab|not found/i.test(err.message) ? 'not found' : err.message); return; }
          chrome.windows.update(tab.windowId, { focused: true }, () => reply(true, {}));
        });
        break;
      default:
        reply(false, undefined, 'unknown');
    }
  } catch (error) {
    reply(false, undefined, String(error));
  }
}

async function connect() {
  const { port, token } = await settings();
  if (!port || !token) { schedule(); return; }
  try { socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`); }
  catch { schedule(); return; }
  socket.onopen = () => { attempt = 0; void setBadge(true); };
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (typeof message.id === 'string' && typeof message.type === 'string') answer(message);
  };
  socket.onclose = () => { void setBadge(false); schedule(); };
  socket.onerror = () => { try { socket.close(); } catch { /* closed already */ } };
}

function schedule() {
  const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
  setTimeout(() => { void connect(); }, wait);
}

// Saving settings on the options page wakes this worker: reconnect immediately instead of waiting
// for a timer the next suspension would kill.
chrome.storage.onChanged.addListener(changes => {
  if (!('port' in changes) && !('token' in changes)) return;
  try { socket?.close(); } catch { /* closed already */ }
  void connect();
});
// MV3 service workers are suspended when idle and setTimeout retries die with them; a repeating
// alarm survives suspension and wakes the worker to recover a dropped connection.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'orbit-reconnect' && (!socket || socket.readyState !== WebSocket.OPEN)) void connect();
});
chrome.alarms.create('orbit-reconnect', { periodInMinutes: 0.5 });
void setBadge(false);
void connect();
