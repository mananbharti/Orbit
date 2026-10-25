/** Live NL-control proof script (developer-run, not CI): pairs a real client with a real desktop
 *  service on this machine and drives nl.control end to end, reading real OS state (pactl) after
 *  every phrase. Run from desktop/: `npm run build && node scripts/nl-live-proof.mjs`
 *  Covers: executed set/get, unknown (no effect), clipboard-scoped denial (no effect),
 *  out-of-range unclear (no clamping), relative up/down against the real level. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDesktop } from '../dist/src/desktop-service.js';
import { OrbitClient } from '../dist/src/integration-client/orbit-client.js';
import { pairDesktop } from '../dist/src/integration-client/pair-desktop.js';

const vol = () => execFileSync('pactl', ['get-sink-volume', '@DEFAULT_SINK@']).toString().match(/(\d+)%/)[1];
const root = mkdtempSync(join(tmpdir(), 'orbit-nl-live-'));
const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0,
  displayName: 'NL Live Proof', discovery: false });
const full = new OrbitClient(await pairDesktop(service.pairing.open(), service.hint));
const scoped = new OrbitClient(await pairDesktop(service.pairing.open(['clipboard']), service.hint));
try {
  await full.start(); await scoped.start();
  execFileSync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '100%']);
  console.log('baseline volume:', vol() + '%');

  const deadline = Date.now() + 15000;
  while ((full.status !== 'connected' || scoped.status !== 'connected') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  console.log('client status:', full.status, scoped.status);
  const r1 = await full.command('nl.control', { text: 'volume 42' });
  console.log('full "volume 42" ->', JSON.stringify(r1.payload), '| pactl now:', vol() + '%');

  const r2 = await full.command('nl.control', { text: 'volume kitna hai' });
  console.log('full "volume kitna hai" ->', JSON.stringify(r2.payload));

  const r3 = await full.command('nl.control', { text: 'make me a sandwich' });
  console.log('full "make me a sandwich" ->', JSON.stringify(r3.payload), '| pactl still:', vol() + '%');

  const r4 = await scoped.command('nl.control', { text: 'volume 10' });
  console.log('scoped(clipboard) "volume 10" ->', JSON.stringify(r4.payload), '| pactl still:', vol() + '%');

  const r5 = await full.command('nl.control', { text: 'volume 500' });
  console.log('full "volume 500" ->', JSON.stringify(r5.payload), '| pactl still:', vol() + '%');

  const r6 = await full.command('nl.control', { text: 'volume badha do' });
  console.log('full "volume badha do" ->', JSON.stringify(r6.payload), '| pactl now:', vol() + '%');
  const r7 = await full.command('nl.control', { text: 'awaz kam karo' });
  console.log('full "awaz kam karo" ->', JSON.stringify(r7.payload), '| pactl now:', vol() + '%');
} finally { full.stop(); scoped.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); }
