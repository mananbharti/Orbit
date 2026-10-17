const portEl = document.getElementById('port');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

chrome.storage.local.get(['port', 'token'], values => {
  if (values.port) portEl.value = values.port;
  if (values.token) tokenEl.value = values.token;
});

document.getElementById('save').addEventListener('click', () => {
  const port = Number(portEl.value.trim());
  const token = tokenEl.value.trim();
  if (!port || port < 1024 || port > 65535 || token.length < 16) {
    statusEl.className = 'bad';
    statusEl.textContent = 'Check the port and token against what the Orbit app shows.';
    return;
  }
  statusEl.className = '';
  statusEl.textContent = 'Connecting...';
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  const timer = setTimeout(() => { statusEl.className = 'bad'; statusEl.textContent = 'No answer. Is Orbit running on this computer?'; try { socket.close(); } catch {} }, 4000);
  socket.onopen = () => {
    clearTimeout(timer);
    chrome.storage.local.set({ port, token }, () => {
      statusEl.className = 'ok';
      statusEl.textContent = 'Connected. Your phone can now see this browser\'s tabs.';
    });
    socket.close();
  };
  socket.onclose = event => {
    if (statusEl.className === 'ok') return;
    clearTimeout(timer);
    statusEl.className = 'bad';
    statusEl.textContent = event.code === 4001 ? 'That token does not match. Copy it again from the Orbit app.' : 'Could not connect. Is Orbit running on this computer?';
  };
  socket.onerror = () => { try { socket.close(); } catch {} };
});
