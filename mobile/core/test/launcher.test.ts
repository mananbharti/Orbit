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
    ? { catalogRevision: REV, apps: [{ appId: B, name: 'Two' }], nextCursor: null }
    : { catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: `${REV}:1` });
  assert.deepEqual((await api.list()).map(a => a.name), ['One', 'Two']);
  assert.equal(calls.length, 2);
  s.stop();
});
test('a catalog that changes during listing is reported as stale', async () => {
  const { s, api } = await setup((_t, p) => p.cursor
    ? { catalogRevision: '99999999-9999-4999-8999-999999999999', apps: [], nextCursor: null }
    : { catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: `${REV}:1` });
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  s.stop();
});
test('a repeating cursor cannot loop forever', async () => {
  const { s, api } = await setup(() => ({ catalogRevision: REV, apps: [], nextCursor: `${REV}:1` }));
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'LAUNCHER_LIMIT');
  s.stop();
});
test('launch only works for listed apps and sends the catalog revision', async () => {
  const { s, api, calls } = await setup(type => type === 'launcher.list'
    ? { catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: null } : { status: 'requested' });
  await assert.rejects(api.launch(A), NotSent);
  await api.list();
  await assert.rejects(api.launch(B), NotSent);
  await api.launch(A);
  assert.deepEqual(calls.at(-1), { type: 'launcher.launch', payload: { appId: A, catalogRevision: REV } });
  s.stop();
});
test('a stale-catalog launch forgets the catalog so the next launch needs a fresh list', async () => {
  let stale = true;
  const { t, s, api } = await setup(() => ({ catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: null }));
  await api.list();
  t.last.onSend = text => { const m = parseSent(text); if (stale) t.last.fail(m.requestId, 'LAUNCHER_STALE_CATALOG'); else t.last.reply(m.requestId, { status: 'requested' }); };
  await assert.rejects(api.launch(A), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  stale = false;
  await assert.rejects(api.launch(A), NotSent);
  s.stop();
});
test('a reconnect forgets the catalog', async () => {
  const { t, s, api } = await setup(() => ({ catalogRevision: REV, apps: [{ appId: A, name: 'One' }], nextCursor: null }));
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
  t.last.onSend = text => setTimeout(() => { const m = parseSent(text); t.last.reply(m.requestId, { catalogRevision: REV, apps: [], nextCursor: null }); }, 60);
  assert.deepEqual(await new LauncherApi(s).list(), []);
  s.stop();
});
