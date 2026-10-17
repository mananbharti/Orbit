import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceDirectory } from '../src/security-pairing/device-directory.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ProtocolError } from '../src/protocol/errors.js';
import type { CommandContext } from '../src/command-router/command-context.js';

function context(deviceId = 'ffffffff-ffff-4fff-bfff-ffffffffffff', authorized = true): CommandContext {
  return { session: { deviceId, version: 1 } as unknown as CommandContext['session'], requestId: 'req',
    connection: { isAuthorized: () => authorized } as unknown as CommandContext['connection'] };
}

function setup(): { registry: CommandRegistry; store: FilePairedCredentialStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-dir-'));
  return { registry: new CommandRegistry(), store: new FilePairedCredentialStore(join(dir, 'paired.json')), dir };
}
const OTHER = 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee';

test('device-directory lists the caller as current and other devices with their scopes', async () => {
  const { registry, store, dir } = setup();
  new DeviceDirectory(registry, store);
  store.enroll(); store.enroll(['clipboard']);
  const handler = registry.get('pair.devices')!;
  const result = await handler.execute({}, context()) as { current: string; devices: { deviceId: string; scopes: 'all' | string[] }[] };
  assert.equal(result.current, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(result.devices.length, 2);
  assert.deepEqual(result.devices.find(d => d.scopes !== 'all')!.scopes, ['clipboard']);
  rmSync(dir, { recursive: true, force: true });
});

test('device-directory updates scopes persistently and restores full access with all', async () => {
  const { registry, store, dir } = setup();
  new DeviceDirectory(registry, store);
  store.enroll(); // full access
  const file = join(dir, 'paired.json');
  const id = (store.list()[0]!).deviceId;
  const handler = registry.get('pair.scopes.set')!;
  await handler.execute({ deviceId: id, scopes: ['launcher', 'input'] }, context());
  assert.deepEqual([...store.scopesOf(id) ?? []].sort(), ['input', 'launcher']);
  assert.match(readFileSync(file, 'utf8'), /launcher/); // written through
  await handler.execute({ deviceId: id, scopes: 'all' }, context());
  assert.equal(store.scopesOf(id), undefined); // full access again
  assert.doesNotMatch(readFileSync(file, 'utf8'), /launcher/);
  rmSync(dir, { recursive: true, force: true });
});

test('device-directory rejects unknown devices, self-scoping, and unauthenticated calls', async () => {
  const { registry, store, dir } = setup();
  new DeviceDirectory(registry, store);
  const handler = registry.get('pair.scopes.set')!;
  await assert.rejects(handler.execute({ deviceId: OTHER, scopes: ['clipboard'] }, context()), (error: ProtocolError) => error.code === 'PAIR_NOT_FOUND');
  await assert.rejects(handler.execute({ deviceId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', scopes: ['clipboard'] }, context()), (error: ProtocolError) => error.code === 'PAIR_SELF_SCOPES');
  await assert.rejects(handler.execute({ deviceId: OTHER, scopes: ['clipboard'] }, context(OTHER, false)), (error: ProtocolError) => error.code === 'UNAUTHENTICATED');
  rmSync(dir, { recursive: true, force: true });
});
