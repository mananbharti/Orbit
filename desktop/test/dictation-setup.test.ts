/** DictationSetup state machine: honest status at every point, manual retry, cancel, and the 24h automatic backoff; depends on a real CommandRegistry and temp dirs; performs no network access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { DictationSetup, autoProvisionAllowed, markProvisionAttempt, AUTO_RETRY_AFTER_MS, ProvisionError, type EnginePaths } from '../src/dictation/provision.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'orbit-setup-test-'));
const ctx = { connection: { isAuthorized: () => true, closed: new AbortController().signal, id: 'c1', send: () => undefined }, session: { deviceId: 'd1', sessionId: 's1', scopes: 'all' as const } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (registry: CommandRegistry, type: string) => registry.get(type)!.execute({}, ctx as any) as Promise<Record<string, string>>;
const log = () => new ActivityLog(10);
const paths: EnginePaths = { binary: '/nope/whisper-cli', model: '/nope/model.bin' };

test('backoff: a recent failed attempt blocks automatic retries but not manual ones', () => {
  const dir = tmp();
  assert.equal(autoProvisionAllowed(dir), true); // never attempted
  markProvisionAttempt(dir);
  assert.equal(autoProvisionAllowed(dir), false);
  markProvisionAttempt(dir, Date.now() - AUTO_RETRY_AFTER_MS - 1);
  assert.equal(autoProvisionAllowed(dir), true);
});

test('status starts off, flips to downloading then ready, and onReady fires with the engine paths', async () => {
  const registry = new CommandRegistry();
  let ready: EnginePaths | undefined;
  const setup = new DictationSetup(registry, tmp(), p => { ready = p; }, log(), { provision: async () => paths });
  assert.equal(setup.state.state, 'off');
  assert.deepEqual(await call(registry, 'dictation.status'), { state: 'off' });
  await setup.start(false);
  assert.equal(setup.state.state, 'ready');
  assert.deepEqual(ready, paths);
  assert.deepEqual(await call(registry, 'dictation.status'), { state: 'ready' });
});

test('a failed download surfaces failed+reason, and dictation.retry starts over honestly', async () => {
  const registry = new CommandRegistry();
  let attempts = 0;
  const setup = new DictationSetup(registry, tmp(), () => undefined, log(), {
    provision: async () => { attempts++; if (attempts === 1) throw new ProvisionError('HASH_MISMATCH'); return paths; } });
  await setup.start(false);
  assert.equal(setup.state.state, 'failed');
  assert.equal(setup.state.reason, 'HASH_MISMATCH');
  assert.deepEqual(await call(registry, 'dictation.status'), { state: 'failed', reason: 'HASH_MISMATCH' });
  await call(registry, 'dictation.retry');
  await setup.start(true); // joins the in-flight retry
  assert.equal(setup.state.state, 'ready');
  assert.equal(attempts, 2);
});

test('cancel aborts an in-flight download and reports failed/cancelled', async () => {
  const registry = new CommandRegistry();
  let seenSignal: AbortSignal | undefined;
  const setup = new DictationSetup(registry, tmp(), () => undefined, log(), {
    provision: o => new Promise<EnginePaths>((_res, rej) => { seenSignal = o.signal; o.signal?.addEventListener('abort', () => rej(new ProvisionError('DOWNLOAD_FAILED', 'cancelled'))); }) });
  const run = setup.start(false);
  assert.equal(setup.state.state, 'downloading');
  setup.cancel();
  assert.equal(setup.state.state, 'failed');
  assert.equal(setup.state.reason, 'cancelled');
  await run;
  assert.ok(seenSignal?.aborted);
});

test('autoStart attaches an existing env engine, skips downloads within the backoff window, and starts once after it', async () => {
  const dir = tmp();
  const bin = join(dir, 'w'); const model = join(dir, 'm');
  writeFileSync(bin, 'x'); writeFileSync(model, 'y');
  const r1 = new CommandRegistry();
  const s1 = new DictationSetup(r1, dir, () => undefined, log(), { env: { ORBIT_WHISPER_BIN: bin, ORBIT_WHISPER_MODEL: model }, provision: async () => { throw new Error('must not download'); } });
  assert.deepEqual(s1.autoStart(), { binary: bin, model });
  assert.equal(s1.state.state, 'ready');

  const dir2 = tmp();
  markProvisionAttempt(dir2); // a failure ten minutes ago
  let started = 0;
  const r2 = new CommandRegistry();
  const s2 = new DictationSetup(r2, dir2, () => undefined, log(), { provision: async () => { started++; return paths; } });
  assert.equal(s2.autoStart(), undefined);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(started, 0);
  assert.equal(s2.state.state, 'off'); // honestly not ready, not silently retrying

  const dir3 = tmp();
  markProvisionAttempt(dir3, Date.now() - AUTO_RETRY_AFTER_MS - 1000);
  const r3 = new CommandRegistry();
  const s3 = new DictationSetup(r3, dir3, () => undefined, log(), { provision: async () => { started++; return paths; } });
  s3.autoStart();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(started, 1);
  assert.equal(s3.state.state, 'ready');
});

test('status/retry/cancel require an authorized connection', async () => {
  const registry = new CommandRegistry();
  new DictationSetup(registry, tmp(), () => undefined, log(), { provision: async () => paths });
  const bad = { connection: { isAuthorized: () => false }, session: { deviceId: 'd', sessionId: 's', scopes: 'all' as const } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (type: string) => registry.get(type)!.execute({}, bad as any);
  await assert.rejects(exec('dictation.status'), /UNAUTHENTICATED/);
  await assert.rejects(exec('dictation.retry'), /UNAUTHENTICATED/);
  await assert.rejects(exec('dictation.setup.cancel'), /UNAUTHENTICATED/);
});
