/** Live preview wiring: the REAL mobile-core OrbitSession + NlControlApi talking to a REAL desktop
 *  through a loopback bridge that terminates the pinned HTTPS/WSS (browsers cannot pin certs or set
 *  WS Authorization headers; the bridge substitutes exactly that OS-native transport piece).
 *  Everything above the transport - session auth, command protocol, API, UI - is production code. */
import { NlControlApi, OrbitSession, type Channel, type ChannelHandlers, type PairedDesktop, type PinnedTransport } from '@orbit/core';

const BRIDGE = 'http://127.0.0.1:8461';

function bridgeTransport(paired: PairedDesktop): PinnedTransport {
  const trust = { desktopServiceId: paired.desktopServiceId, endpoint: paired.endpoint, certificateFingerprint: paired.certificateFingerprint };
  return {
    async postCredential(_t, path, token) {
      const res = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) { const { AuthenticationRejected } = await import('@orbit/core'); throw new AuthenticationRejected(); }
      return res.json();
    },
    openChannel(_t, sessionToken, handlers: ChannelHandlers): Channel {
      // The session token rides the WebSocket subprotocol; the bridge moves it to the Authorization header.
      const ws = new WebSocket(`${BRIDGE.replace('http', 'ws')}/channel`, sessionToken);
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = e => handlers.onMessage(String(e.data));
      ws.onclose = () => handlers.onClose();
      return { send: text => ws.send(text), close: () => ws.close() };
    },
  };
}

export async function liveNl(): Promise<NlControlApi> {
  const paired: PairedDesktop = await (await fetch(`${BRIDGE}/paired.json`)).json();
  const session = new OrbitSession(paired, bridgeTransport(paired), { uuid: () => crypto.randomUUID(), retryBaseMs: 50 });
  void session.start();
  const api = new NlControlApi(session);
  // Wait for the first real connection before handing the API to the screen.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = setInterval(() => { if (session.status === 'connected') { clearInterval(poll); resolve(); } else if (Date.now() > deadline) { clearInterval(poll); reject(new Error('live session did not connect')); } }, 50);
  });
  return api;
}
