import assert from 'node:assert/strict';
import test from 'node:test';
import { LauncherApi } from '../src/launcher.js';
import { CommandError, NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

const REV = '77777777-7777-4777-8777-777777777777';
const hex = (i: number) => i.toString(16).padStart(64, '0');
let n = 0;
const uuid = () => `88888888-8888-4888-8888-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown, commandTimeoutMs?: number, delay = 0) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0, ...(commandTimeoutMs ? { commandTimeoutMs } : {}) });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => {
    const m = parseSent(text); calls.push({ type: m.type, payload: m.payload });
    const go = () => t.last.reply(m.requestId, handler(m.type, m.payload));
    if (delay) setTimeout(go, delay); else go();
  };
  return { t, s, calls, api: new LauncherApi(s) };
}
/** Catalog of `total` apps served 32 per page with numeric cursors. */
function catalog(total: number, pinned: string[] = []) {
  return (_t: string, p: any) => {
    const start = p.cursor ? Number(p.cursor) : 0;
    const end = Math.min(total, start + 32);
    return { catalogRevision: REV, apps: Array.from({ length: end - start }, (_, i) => ({ appId: hex(start + i + 1), name: `App ${start + i}` })), nextCursor: end < total ? String(end) : null, pinned };
  };
}

test('a catalog of exactly 2048 apps lists and 2049 is refused', async () => {
  const ok = await setup(catalog(2048));
  assert.equal((await ok.api.list()).length, 2048);
  ok.s.stop();
  const over = await setup(catalog(2049));
  await assert.rejects(over.api.list(), (e: CommandError) => e.code === 'LAUNCHER_LIMIT');
  over.s.stop();
});
test('list keeps the desktop pins and hands out copies, not internal state', async () => {
  const { s, api } = await setup(catalog(2, [hex(2)]));
  const apps = await api.list();
  apps[0]!.appId = hex(77);
  await assert.rejects(api.icon(hex(77)), NotSent);
  assert.deepEqual(api.getPinned(), [hex(2)]);
  api.getPinned().push('x');
  assert.deepEqual(api.getPinned(), [hex(2)]);
  s.stop();
});
test('a reconnect forgets pins and cached icons', async () => {
  const { t, s, api } = await setup((type, p) => type === 'launcher.icons' ? { icons: { [hex(1)]: 'QUJD' } } : catalog(1, [hex(1)])(type, p));
  await api.list(); await api.icons([hex(1)]);
  assert.deepEqual(api.getPinned(), [hex(1)]);
  t.last.drop();
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(api.getPinned(), []);
  await assert.rejects(api.icons([hex(1)]), NotSent);
  s.stop();
});
test('a stale launch forgets the apps, not just the revision', async () => {
  const { t, s, api } = await setup(catalog(1));
  await api.list();
  t.last.onSend = text => t.last.fail(parseSent(text).requestId, 'LAUNCHER_STALE_CATALOG');
  await assert.rejects(api.launch(hex(1)), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  await assert.rejects(api.icon(hex(1)), NotSent);
  s.stop();
});
test('any other launch failure keeps the catalog usable', async () => {
  const { t, s, api, calls } = await setup(catalog(1));
  await api.list();
  t.last.onSend = text => { calls.push({ type: 'x', payload: {} }); t.last.fail(parseSent(text).requestId, 'LAUNCHER_NOT_FOUND'); };
  await assert.rejects(api.launch(hex(1)), CommandError);
  await assert.rejects(api.launch(hex(1)), (e: CommandError) => e.code === 'LAUNCHER_NOT_FOUND');
  assert.equal(calls.filter(c => c.type === 'x').length, 2);
  s.stop();
});
test('creating a scene sends no id key at all', async () => {
  const { s, api, calls } = await setup(() => ({ scenes: [] }));
  await api.saveScene('Work', [hex(1)]);
  assert.deepEqual(Object.keys(calls[0]!.payload).sort(), ['appIds', 'name']);
  s.stop();
});
test('icons batch by 8, serve unknown apps as null without asking, and cache hits', async () => {
  const { s, api, calls } = await setup((type, p) => type === 'launcher.icons'
    ? { icons: Object.fromEntries(p.appIds.map((id: string) => [id, 'QUJD'])) } : catalog(20)(type, p));
  await api.list();
  const ids = Array.from({ length: 20 }, (_, i) => hex(i + 1));
  const out = await api.icons([...ids, hex(999)]);
  assert.equal(out.size, 21);
  assert.equal(out.get(hex(999)), null);
  assert.equal(out.get(hex(20)), 'QUJD');
  const icons = calls.filter(c => c.type === 'launcher.icons');
  assert.deepEqual(icons.map(c => c.payload.appIds.length), [8, 8, 4]);
  assert.ok(icons.every(c => c.payload.catalogRevision === REV));
  await api.icons([...ids, hex(999)]);
  assert.equal(calls.filter(c => c.type === 'launcher.icons').length, 3);
  s.stop();
});
test('apps cut by the byte budget stay uncached and are retried next call', async () => {
  let budget = true;
  const { s, api, calls } = await setup((type, p) => type === 'launcher.icons'
    ? { icons: Object.fromEntries(p.appIds.filter((id: string) => !budget || id === hex(1)).map((id: string) => [id, 'QUJD'])) } : catalog(2)(type, p));
  await api.list();
  const first = await api.icons([hex(1), hex(2)]);
  assert.equal(first.has(hex(2)), false);
  budget = false;
  assert.equal((await api.icons([hex(1), hex(2)])).get(hex(2)), 'QUJD');
  assert.deepEqual(calls.filter(c => c.type === 'launcher.icons').at(-1)!.payload.appIds, [hex(2)]);
  s.stop();
});
test('icon() asks only for listed apps, caches a null result and rejects before listing', async () => {
  const { s, api, calls } = await setup((type, p) => type === 'launcher.icon' ? { icon: null } : catalog(1)(type, p));
  await assert.rejects(api.icon(hex(1)), NotSent);
  await api.list();
  await assert.rejects(api.icon(hex(5)), NotSent);
  assert.equal(await api.icon(hex(1)), null);
  assert.equal(await api.icon(hex(1)), null);
  assert.equal(calls.filter(c => c.type === 'launcher.icon').length, 1);
  s.stop();
});
test('every launcher command gets the long timeout, including layout, scenes and icons', async () => {
  const { s, api } = await setup((type, p) => {
    if (type === 'launcher.list') return catalog(2)(type, p);
    if (type === 'launcher.icon') return { icon: null };
    if (type === 'launcher.icons') return { icons: {} };
    if (type.startsWith('launcher.scene.launch')) return { launched: 0, failed: [] };
    if (type.startsWith('launcher.scene')) return { scenes: [] };
    if (type === 'launcher.launch') return { status: 'requested' };
    return { pinned: [] };
  }, 20, 60);
  await api.list();
  await api.pin(hex(1)); await api.unpin(hex(1)); await api.reorder([]);
  await api.scenes(); await api.saveScene('a', []); await api.deleteScene('88888888-8888-4888-8888-000000000001'); await api.launchScene('88888888-8888-4888-8888-000000000001');
  await api.icons([hex(1)]); await api.icon(hex(2)); await api.launch(hex(1));
  s.stop();
});
