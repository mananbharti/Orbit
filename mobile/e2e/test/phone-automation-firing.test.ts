/** The real clock path: a saved automation fires at its minute on the live desktop and runs its action exactly once. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { AutomationApi } from '../../core/src/automation.js';
import { LauncherApi } from '../../core/src/launcher.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a saved automation actually fires at its minute and launches the app exactly once', { timeout: 200_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-auto-fire-'));
  const launches: string[] = [];
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    biometric: { verify: async () => true }, // fixture stands in for the desktop owner's confirmation
    launcher: { createAdapter: () => ({
      list: async () => [{ key: 'registration', name: 'Notes', revision: 'one' }],
      launch: async (app, authorize) => { authorize(); launches.push(app.key); } }) } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();

  const appId = (await new LauncherApi(session).list())[0]!.appId;
  const target = new Date(Date.now() + 70_000); // land safely inside the next minute, past any tick alignment
  const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const automations = new AutomationApi(session);
  const saved = await automations.save({ time: hhmm, days: [], action: { type: 'app', appId } });
  const id = saved[0]!.id;

  const deadline = Date.now() + 150_000;
  let fired: number | undefined;
  while (Date.now() < deadline) {
    await sleep(5_000);
    fired = (await automations.refresh()).find(a => a.id === id)?.lastFiredAt;
    if (fired !== undefined) break;
  }
  assert.ok(fired !== undefined, 'the automation fired on the desktop clock');
  assert.deepEqual(launches, ['registration'], 'its action ran exactly once, on the right app');
  await sleep(16_000); // one more tick window...
  assert.equal(launches.length, 1, '...does not fire it again');
});

test('a scene automation fires every app in the scene exactly once', { timeout: 200_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-auto-scene-'));
  const launches: string[] = [];
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    biometric: { verify: async () => true }, // fixture stands in for the desktop owner's confirmation
    launcher: { createAdapter: () => ({
      list: async () => [{ key: 'registration', name: 'Notes', revision: 'one' }, { key: 'registration-2', name: 'Browser', revision: 'one' }],
      launch: async (app, authorize) => { authorize(); launches.push(app.key); } }) } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();

  const launcher = new LauncherApi(session);
  const appIds = (await launcher.list()).map(a => a.appId);
  const sceneId = (await launcher.saveScene('Morning', appIds))[0]!.id;
  const target = new Date(Date.now() + 70_000);
  const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const automations = new AutomationApi(session);
  const saved = await automations.save({ time: hhmm, days: [], action: { type: 'scene', sceneId } });
  const id = saved[0]!.id;

  const deadline = Date.now() + 150_000;
  let fired: number | undefined;
  while (Date.now() < deadline) {
    await sleep(5_000);
    fired = (await automations.refresh()).find(a => a.id === id)?.lastFiredAt;
    if (fired !== undefined) break;
  }
  assert.ok(fired !== undefined, 'the scene automation fired on the desktop clock');
  assert.deepEqual(launches.sort(), ['registration', 'registration-2'], 'every app in the scene launched');
  await sleep(16_000);
  assert.equal(launches.length, 2, 'and nothing fired twice');
});

test('a power automation fires on the real clock and reaches the system adapter exactly once', { timeout: 200_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-auto-power-'));
  const powered: string[] = [];
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    biometric: { verify: async () => true }, // fixture stands in for the desktop owner's confirmation
    system: { createAdapter: () => ({
      power: async (action) => { powered.push(action); },
      getVolume: async () => ({ level: 50, muted: false }),
      setVolume: async () => {},
      getBrightness: async () => null,
      setBrightness: async () => {},
      getDisplayMode: async () => ({ theme: null, nightLight: null }),
      setDisplayMode: async () => {},
    }) } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();

  const target = new Date(Date.now() + 70_000);
  const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const automations = new AutomationApi(session);
  const saved = await automations.save({ time: hhmm, days: [], action: { type: 'power', action: 'lock' } });
  const id = saved[0]!.id;

  const deadline = Date.now() + 150_000;
  let fired: number | undefined;
  while (Date.now() < deadline) {
    await sleep(5_000);
    fired = (await automations.refresh()).find(a => a.id === id)?.lastFiredAt;
    if (fired !== undefined) break;
  }
  assert.ok(fired !== undefined, 'the power automation fired on the desktop clock');
  assert.deepEqual(powered, ['lock'], 'the lock action reached the system adapter exactly once');
});

test('at the same minute only the enabled, day-matching automation fires; a disabled one and a wrong-weekday one stay quiet', { timeout: 200_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-auto-select-'));
  const launches: string[] = [];
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    biometric: { verify: async () => true }, // fixture stands in for the desktop owner's confirmation
    launcher: { createAdapter: () => ({
      list: async () => [{ key: 'registration', name: 'Notes', revision: 'one' }],
      launch: async (app, authorize) => { authorize(); launches.push(app.key); } }) } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();

  const appId = (await new LauncherApi(session).list())[0]!.appId;
  const target = new Date(Date.now() + 70_000);
  const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const automations = new AutomationApi(session);
  const action = { type: 'app', appId } as const;
  const live = (await automations.save({ time: hhmm, days: [target.getDay()], action }))[0]!.id;
  const off = (await automations.save({ time: hhmm, days: [], action })).find(a => a.id !== live)!.id;
  await automations.setEnabled(off, false);
  const wrongDay = (await automations.save({ time: hhmm, days: [(target.getDay() + 3) % 7], action })).find(a => a.id !== live && a.id !== off)!.id;

  const deadline = Date.now() + 150_000;
  let fired: number | undefined;
  while (Date.now() < deadline) {
    await sleep(5_000);
    fired = (await automations.refresh()).find(a => a.id === live)?.lastFiredAt;
    if (fired !== undefined) break;
  }
  assert.ok(fired !== undefined, 'the enabled, day-matching automation fired');
  await sleep(3_000);
  const all = await automations.refresh();
  assert.equal(all.find(a => a.id === off)?.lastFiredAt, undefined, 'the disabled one never fired');
  assert.equal(all.find(a => a.id === wrongDay)?.lastFiredAt, undefined, 'the wrong-weekday one never fired');
  assert.deepEqual(launches, ['registration'], 'exactly one launch happened');
});
