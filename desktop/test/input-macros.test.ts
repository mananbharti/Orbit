/** Tests keyboard-macro storage and commands plus the extended key set; depends on a temp directory and synthetic devices. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { InputControl } from '../src/input-simulation/input-control.js';
import { KeyboardMacroStore } from '../src/input-simulation/keyboard-macros.js';
import { inputEventSchema } from '../src/protocol/input.js';
import type { InputDevice } from '../src/os-integration/input-device.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { toOps } from '../src/os-integration/input-device.windows.js';
import { core } from './helpers.js';

class FakeDevice implements InputDevice {
  async open(): Promise<void> {}
  async apply(): Promise<void> {}
  async releaseAll(): Promise<void> {}
  async dispose(): Promise<void> {}
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-input-macros-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = core();
  const storePath = join(root, 'keyboard-macros.json');
  const control = new InputControl(setup.registry, () => new FakeDevice(), setup.log, undefined, new KeyboardMacroStore(storePath));
  const issued = setup.auth.issue(setup.credential)!;
  const closed = new AbortController();
  const connection = { id: randomUUID(), closed: closed.signal, isAuthorized: () => !closed.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, connection);
  return { ...setup, control, command, storePath };
}
function result(response: ResponseMessage): JsonValue { assert.ok(response.payload.ok); return response.payload.result; }
function error(response: ResponseMessage, code: string): void { assert.deepEqual(response.payload, { ok: false, error: { code } }); }

test('macros save, list, edit and delete; names dedupe case-insensitively', async t => {
  const { command } = fixture(t);
  const steps: JsonValue[] = [{ key: 'v', modifiers: ['ctrl', 'shift'] }, { key: 'enter' }];
  const saved = result(await command('input.macro.save', { name: 'Paste plain', steps })) as { macros: { id: string; name: string }[] };
  assert.equal(saved.macros.length, 1);
  const id = saved.macros[0]!.id;
  error(await command('input.macro.save', { name: 'paste PLAIN', steps }), 'INPUT_CONFLICT');
  error(await command('input.macro.save', { id: randomUUID(), name: 'Ghost', steps }), 'INPUT_NOT_FOUND');
  const listed = result(await command('input.macros', {})) as { macros: { name: string; steps: unknown[] }[] };
  assert.equal(listed.macros[0]!.name, 'Paste plain');
  assert.equal(listed.macros[0]!.steps.length, 2);
  const removed = result(await command('input.macro.delete', { id })) as { macros: unknown[] };
  assert.equal(removed.macros.length, 0);
});

test('macros survive a restart; a corrupt file starts empty', t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-input-macros-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'keyboard-macros.json');
  const first = new KeyboardMacroStore(path);
  first.save('Paste plain', [{ key: 'v', modifiers: ['ctrl', 'shift'] }]);
  assert.equal(new KeyboardMacroStore(path).list()[0]!.name, 'Paste plain');
  writeFileSync(path, '{oops', 'utf8');
  assert.deepEqual(new KeyboardMacroStore(path).list(), []);
});

test('letters, digits and function keys are valid input events with real Windows VK codes', () => {
  for (const key of ['a', 'z', '0', '9', 'f1', 'f12']) assert.equal(inputEventSchema.safeParse({ t: 'key', key }).success, true);
  for (const action of ['tap', 'down', 'up']) assert.equal(inputEventSchema.safeParse({ t: 'key', key: 'v', modifiers: ['ctrl'], action }).success, true);
  assert.equal(inputEventSchema.safeParse({ t: 'key', key: 'v', action: 'hold' }).success, false);
  assert.deepEqual(toOps({ t: 'key', key: 'v', modifiers: ['ctrl', 'shift'] }), [
    { k: 'key', vk: 0x11, flags: 0 }, { k: 'key', vk: 0x10, flags: 0 },
    { k: 'key', vk: 0x56, flags: 0 }, { k: 'key', vk: 0x56, flags: 2 },
    { k: 'key', vk: 0x10, flags: 2 }, { k: 'key', vk: 0x11, flags: 2 }]);
  assert.deepEqual(toOps({ t: 'key', key: 'f5' })[0], { k: 'key', vk: 0x74, flags: 0 });
  assert.deepEqual(toOps({ t: 'key', key: '9' })[0], { k: 'key', vk: 0x39, flags: 0 });
});
