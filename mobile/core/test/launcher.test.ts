import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { LauncherApi } from '../src/launcher.js';
import { CommandError, NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

const REV = '77777777-7777-4777-8777-777777777777';
const A = 'a'.repeat(64); const B = 'b'.repeat(64);
let n = 0;
const uuid = () => `88888888-8888-4888-8888-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new LauncherApi(s) };
}

test('list follows cursors and returns all apps', async () => {
  const { s, api, calls } = await setup((_t, p) => p.cursor
    ? { catalogRevision: REV, apps: [{ appId: B, name: 'Two' }], nextCursor: null, pinned: [] }
    : { catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: `${REV}:1`, pinned: [] });
  assert.deepEqual((await api.list()).map(a => a.name), ['One', 'Two']);
  assert.equal(calls.length, 2);
  s.stop();
});
test('a catalog that changes during listing is reported as stale', async () => {
  const { s, api } = await setup((_t, p) => p.cursor
    ? { catalogRevision: '99999999-9999-4999-8999-999999999999', apps: [], nextCursor: null, pinned: [] }
    : { catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: `${REV}:1`, pinned: [] });
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  s.stop();
});
test('a repeating cursor cannot loop forever', async () => {
  const { s, api } = await setup(() => ({ catalogRevision: REV, apps: [], nextCursor: `${REV}:1`, pinned: [] }));
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'LAUNCHER_LIMIT');
  s.stop();
});
test('launch only works for listed apps and sends the catalog revision', async () => {
  const { s, api, calls } = await setup(type => type === 'launcher.list'
    ? { catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: null, pinned: [] } : { status: 'requested' });
  await assert.rejects(api.launch(A), NotSent);
  await api.list();
  await assert.rejects(api.launch(B), NotSent);
  await api.launch(A);
  assert.deepEqual(calls.at(-1), { type: 'launcher.launch', payload: { appId: A, catalogRevision: REV } });
  s.stop();
});
test('a stale-catalog launch forgets the catalog so the next launch needs a fresh list', async () => {
  let stale = true;
  const { t, s, api } = await setup(() => ({ catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: null, pinned: [] }));
  await api.list();
  t.last.onSend = text => { const m = parseSent(text); if (stale) t.last.fail(m.requestId, 'LAUNCHER_STALE_CATALOG'); else t.last.reply(m.requestId, { status: 'requested' }); };
  await assert.rejects(api.launch(A), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  stale = false;
  await assert.rejects(api.launch(A), NotSent);
  s.stop();
});
test('a reconnect forgets the catalog', async () => {
  const { t, s, api } = await setup(() => ({ catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: null, pinned: [] }));
  await api.list();
  t.last.drop();
  await new Promise(r => setTimeout(r, 40));
  await assert.rejects(api.launch(A), NotSent);
  s.stop();
});
test('malformed replies are rejected', async () => {
  const { s, api } = await setup(() => ({ apps: 'x' }));
  await assert.rejects(api.list(), InvalidDesktopReply);
  s.stop();
});
test('launcher commands get a longer timeout than the default', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, commandTimeoutMs: 20, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = text => setTimeout(() => { const m = parseSent(text); t.last.reply(m.requestId, { catalogRevision: REV, apps: [], nextCursor: null, pinned: [] }); }, 60);
  assert.deepEqual(await new LauncherApi(s).list(), []);
  s.stop();
});

test('icons batch into one command per 8 apps and cache per app', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => String(i).repeat(64));
  const { s, api, calls } = await setup((type, p) => type === 'launcher.list'
    ? { catalogRevision: REV, apps: ids.map((appId, i) => ({ appId, name: `App ${i}` })), nextCursor: null, pinned: [] }
    : { icons: Object.fromEntries((p.appIds as string[]).map(id => [id, Buffer.from(`png-${id[0]}`).toString('base64')])) });
  await api.list();
  const icons = await api.icons(ids);
  assert.equal(icons.size, 10);
  assert.equal(Buffer.from(icons.get(ids[3]!)!, 'base64').toString(), 'png-3');
  const batches = calls.filter(c => c.type === 'launcher.icons');
  assert.equal(batches.length, 2); // 8 + 2, not 10 round trips
  assert.equal(batches[0]!.payload.appIds.length, 8);
  await api.icons(ids); // fully cached: no new commands
  assert.equal(calls.filter(c => c.type === 'launcher.icons').length, 2);
  s.stop();
});
test('apps cut from a batch response are simply fetched again; unknown apps cache as null', async () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  const { s, api } = await setup((type, _p) => type === 'launcher.list'
    ? { catalogRevision: REV, apps: [{ appId: ids[0], name: 'One' }], nextCursor: null, pinned: [] }
    : { icons: {} }); // desktop cut everything (byte budget)
  await api.list();
  const icons = await api.icons([...ids, 'c'.repeat(64)]);
  assert.equal(icons.has(ids[0]!), false); // cut: still uncached, retried next call
  assert.equal(icons.get('c'.repeat(64)), null); // unknown on the desktop list: null
  s.stop();
});

test('pin, unpin and reorder talk to the desktop and track the pinned order', async () => {
  let pins: string[] = [];
  const { s, api, calls } = await setup((type, p) => {
    if (type === 'launcher.list') return { catalogRevision: REV, apps: [{ appId: A, name: 'One' }, { appId: B, name: 'Two' }], nextCursor: null, pinned: pins };
    if (type === 'launcher.pin') pins = [...pins, p.appId];
    if (type === 'launcher.unpin') pins = pins.filter(id => id !== p.appId);
    if (type === 'launcher.reorder') pins = p.appIds;
    return { pinned: pins };
  });
  await api.list();
  assert.deepEqual(await api.pin(B), [B]);
  assert.deepEqual(await api.pin(A), [B, A]);
  assert.deepEqual(api.getPinned(), [B, A]);
  assert.deepEqual(await api.reorder([A, B]), [A, B]);
  assert.deepEqual(await api.unpin(B), [A]);
  assert.deepEqual(calls.map(c => c.type), ['launcher.list', 'launcher.pin', 'launcher.pin', 'launcher.reorder', 'launcher.unpin']);
  s.stop();
});
test('a malformed layout reply is rejected instead of corrupting local state', async () => {
  const { s, api } = await setup(() => ({ pinned: 'not-an-array' }));
  await assert.rejects(api.pin(A), InvalidDesktopReply);
  assert.deepEqual(api.getPinned(), []);
  s.stop();
});

test('scenes save, list, delete and launch through the desktop', async () => {
  const scene = { id: '99999999-9999-4999-8999-999999999999', name: 'Work', appIds: [A, B] };
  const { s, api, calls } = await setup(type => {
    if (type === 'launcher.scene.launch') return { launched: 2, failed: [] };
    return { scenes: type === 'launcher.scene.delete' ? [] : [scene] };
  });
  assert.deepEqual(await api.scenes(), [scene]);
  assert.deepEqual(await api.saveScene('Work', [A, B]), [scene]);
  await api.saveScene('Work 2', [A], scene.id);
  assert.equal(calls[2]!.payload.id, scene.id);
  assert.deepEqual(await api.deleteScene(scene.id), []);
  assert.deepEqual(await api.launchScene(scene.id), { launched: 2, failed: [] });
  assert.deepEqual(calls.map(c => c.type), ['launcher.scenes', 'launcher.scene.save', 'launcher.scene.save', 'launcher.scene.delete', 'launcher.scene.launch']);
  s.stop();
});
test('a malformed scenes reply is rejected', async () => {
  const { s, api } = await setup(() => ({ scenes: [{ id: 'not-a-uuid' }] }));
  await assert.rejects(api.scenes(), InvalidDesktopReply);
  s.stop();
});
