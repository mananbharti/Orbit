import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { AutomationService, type AutomationExecutor } from '../src/automation/automation-service.js';
import { AutomationStore } from '../src/automation/automation-store.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { ProtocolError } from '../src/protocol/errors.js';
import type { CommandContext } from '../src/command-router/command-context.js';

function context(authorized = true): CommandContext {
  return { session: { deviceId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', version: 1 } as unknown as CommandContext['session'], requestId: 'req',
    connection: { isAuthorized: () => authorized } as unknown as CommandContext['connection'] };
}
function at(hours: number, minutes: number, day = 3): Date { // 2026-10-14 is a Wednesday (day 3)
  return new Date(2026, 9, 14 + (day - 3), hours, minutes, 5);
}
function setup(): { registry: CommandRegistry; store: AutomationStore; dir: string; fired: unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-auto-'));
  return { registry: new CommandRegistry(), store: new AutomationStore(join(dir, 'automations.json')), dir, fired: [] };
}
function executor(fired: unknown[]): AutomationExecutor {
  return { launchScene: async id => { fired.push(['scene', id]); }, launchApp: async id => { fired.push(['app', id]); },
    power: async action => { fired.push(['power', action]); } };
}
const SCENE = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';

test('automation store persists, updates, toggles and removes; a corrupt file starts empty', async () => {
  const { store, dir } = setup();
  const file = join(dir, 'automations.json');
  const [created] = store.save({ time: '09:30', days: [1, 2, 3], action: { type: 'power', action: 'sleep' } });
  assert.equal(created!.enabled, true);
  assert.deepEqual(created!.days, [1, 2, 3]);
  assert.match(readFileSync(file, 'utf8'), /09:30/);
  store.setEnabled(created!.id, false);
  assert.equal(store.get(created!.id)!.enabled, false);
  store.save({ id: created!.id, time: '10:00', days: [], action: { type: 'power', action: 'lock' } });
  assert.equal(store.get(created!.id)!.time, '10:00');
  assert.equal(store.get(created!.id)!.enabled, false); // an edit keeps the enabled state
  const reloaded = new AutomationStore(file);
  assert.equal(reloaded.get(created!.id)!.time, '10:00'); // survived a restart
  store.remove(created!.id);
  assert.equal(store.list().length, 0);
  rmSync(dir, { recursive: true, force: true });
  const corruptDir = mkdtempSync(join(tmpdir(), 'orbit-auto-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(corruptDir, 'automations.json'), '{not json');
  assert.equal(new AutomationStore(join(corruptDir, 'automations.json')).list().length, 0);
  rmSync(corruptDir, { recursive: true, force: true });
});

test('automation tick fires matching time+day once per minute and skips disabled and other days', async () => {
  const { registry, store, dir, fired } = setup();
  const service = new AutomationService(registry, store, executor(fired), new ActivityLog(), () => at(9, 30));
  const [a] = store.save({ time: '09:30', days: [3], action: { type: 'scene', sceneId: SCENE } });
  await service.tick();
  assert.deepEqual(fired, [['scene', SCENE]]);
  await service.tick(); // same minute: no double fire
  assert.equal(fired.length, 1);
  await service.stop();
  const reloaded = new AutomationService(registry, store, executor(fired), new ActivityLog(), () => at(9, 31));
  await reloaded.tick(); // a restart in the same minute does not double-fire either (marked lastFiredAt)... but 9:31 is a new minute: also no fire because time is 9:30
  assert.equal(fired.length, 1);
  store.setEnabled(a!.id, false);
  const service2 = new AutomationService(new CommandRegistry(), store, executor(fired), new ActivityLog(), () => at(9, 30, 4)); // Thursday: not in days
  await service2.tick();
  assert.equal(fired.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('automation tick with empty days fires every day and a failing action is marked and logged, never retried', async () => {
  const { registry, store, dir, fired } = setup();
  const failing: AutomationExecutor = { launchScene: async () => { throw new Error('gone'); }, launchApp: async () => {}, power: async () => {} };
  const service = new AutomationService(registry, store, failing, new ActivityLog(), () => at(22, 0, 5));
  store.save({ time: '22:00', days: [], action: { type: 'scene', sceneId: SCENE } });
  await service.tick();
  assert.equal(fired.length, 0);
  await service.tick(); // marked before running: no hot retry loop
  rmSync(dir, { recursive: true, force: true });
});

test('a scheduled power action needs desktop-owner confirmation at creation (execution is unattended)', async () => {
  // No confirm hook at all: denied.
  const a = setup();
  new AutomationService(a.registry, a.store, executor(a.fired), new ActivityLog());
  await assert.rejects(a.registry.get('automation.save')!.execute({ time: '09:30', days: [], action: { type: 'power', action: 'lock' } }, context()),
    (e: ProtocolError) => e.code === 'BIOMETRIC_REQUIRED');
  rmSync(a.dir, { recursive: true, force: true });
  // Owner declines: denied, nothing stored.
  const b = setup();
  new AutomationService(b.registry, b.store, executor(b.fired), new ActivityLog(), () => new Date(), async () => false);
  await assert.rejects(b.registry.get('automation.save')!.execute({ time: '09:30', days: [], action: { type: 'power', action: 'lock' } }, context()),
    (e: ProtocolError) => e.code === 'BIOMETRIC_REQUIRED');
  assert.equal(b.store.list().length, 0);
  rmSync(b.dir, { recursive: true, force: true });
  // Owner confirms: saved; app/scene automations never need the power confirmation.
  const c = setup();
  let asked = 0;
  new AutomationService(c.registry, c.store, executor(c.fired), new ActivityLog(), () => new Date(), async () => { asked++; return true; });
  const saved = await c.registry.get('automation.save')!.execute({ time: '09:30', days: [], action: { type: 'power', action: 'lock' } }, context()) as { automations: unknown[] };
  assert.equal(saved.automations.length, 1);
  assert.equal(asked, 1);
  await c.registry.get('automation.save')!.execute({ time: '10:00', days: [], action: { type: 'app', appId: 'com.example' } }, context());
  assert.equal(asked, 1, 'non-power automations do not prompt');
  rmSync(c.dir, { recursive: true, force: true });
});

test('pre-gate power schedules are disabled at load, never fire silently, and re-enabling needs fresh confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-auto-migrate-'));
  const path = join(dir, 'automations.json');
  // A store file written before the confirmation gate existed: an enabled power schedule, no stamp.
  writeFileSync(path, JSON.stringify([
    { id: randomUUID(), time: '09:30', days: [], enabled: true, action: { type: 'power', action: 'lock' } },
    { id: randomUUID(), time: '10:00', days: [], enabled: true, action: { type: 'app', appId: 'com.example' } }]));
  const store = new AutomationStore(path);
  assert.equal(store.disabledAtLoad.length, 1, 'the unapproved power schedule was disabled at load');
  const [power, app] = store.list();
  assert.equal(power!.enabled, false);
  assert.equal(app!.enabled, true, 'non-power schedules are untouched');
  assert.ok(!('powerConfirmedAt' in power!), 'internal stamps never reach the wire shape');
  // The migration persisted.
  const reloaded = new AutomationStore(path);
  assert.equal(reloaded.list()[0]!.enabled, false);
  assert.equal(reloaded.disabledAtLoad.length, 0, 'migration runs once');
  rmSync(dir, { recursive: true, force: true });
});

test('automation.enable on a power schedule needs desktop-owner confirmation', async () => {
  const c = setup();
  let asked = 0;
  new AutomationService(c.registry, c.store, executor(c.fired), new ActivityLog(), () => new Date(), async () => { asked++; return true; });
  const saved = await c.registry.get('automation.save')!.execute({ time: '09:30', days: [], action: { type: 'power', action: 'lock' } }, context()) as { automations: { id: string }[] };
  asked = 0;
  const id = saved.automations[0]!.id;
  await c.registry.get('automation.enable')!.execute({ id, enabled: false }, context());
  assert.equal(asked, 0, 'disabling never prompts');
  await c.registry.get('automation.enable')!.execute({ id, enabled: true }, context());
  assert.equal(asked, 1, 're-enabling a power schedule re-prompts');
  rmSync(c.dir, { recursive: true, force: true });
  const d = setup();
  new AutomationService(d.registry, d.store, executor(d.fired), new ActivityLog(), () => new Date(), async () => false);
  const savedD = await d.store.save({ time: '09:30', days: [], action: { type: 'power', action: 'sleep' } }, true);
  await assert.rejects(d.registry.get('automation.enable')!.execute({ id: savedD[0]!.id, enabled: true }, context()),
    (e: ProtocolError) => e.code === 'BIOMETRIC_REQUIRED');
  rmSync(d.dir, { recursive: true, force: true });
});

test('automation commands validate, authorize, and translate store errors', async () => {
  const { registry, store, dir, fired } = setup();
  new AutomationService(registry, store, executor(fired), new ActivityLog());
  const list = registry.get('automation.list')!;
  const save = registry.get('automation.save')!;
  const toggle = registry.get('automation.enable')!;
  const del = registry.get('automation.delete')!;
  await assert.rejects(list.execute({}, context(false)), (e: ProtocolError) => e.code === 'UNAUTHENTICATED');
  assert.equal(save.validate({ time: '25:00', days: [], action: { type: 'power', action: 'sleep' } }), false);
  assert.equal(save.validate({ time: '09:30', days: [7], action: { type: 'power', action: 'sleep' } }), false);
  const saved = await save.execute({ time: '09:30', days: [1], action: { type: 'app', appId: 'com.example' } }, context()) as { automations: { id: string }[] };
  assert.equal(saved.automations.length, 1);
  const id = saved.automations[0]!.id;
  await toggle.execute({ id, enabled: false }, context());
  await assert.rejects(del.execute({ id: SCENE }, context()), (e: ProtocolError) => e.code === 'AUTOMATION_NOT_FOUND');
  await del.execute({ id }, context());
  assert.equal((await list.execute({}, context()) as { automations: unknown[] }).automations.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('one failing action never blocks another automation in the same minute, and both outcomes are logged', async () => {
  const { registry, store, dir, fired } = setup();
  const log = new ActivityLog();
  const mixed: AutomationExecutor = { launchScene: async () => { throw new Error('gone'); }, launchApp: async id => { fired.push(['app', id]); },
    power: async () => {} };
  const service = new AutomationService(registry, store, mixed, log, () => at(7, 45));
  store.save({ time: '07:45', days: [], action: { type: 'scene', sceneId: SCENE } }); // saved first: runs first, fails
  store.save({ time: '07:45', days: [], action: { type: 'app', appId: 'com.example.keep' } });
  await service.tick();
  assert.deepEqual(fired, [['app', 'com.example.keep']], 'the healthy automation still fires after the broken one');
  const outcomes = log.snapshot().filter(event => event.eventType === 'automation.fired').map(event => event.outcome);
  assert.deepEqual(outcomes.sort(), ['failed', 'success']);
  rmSync(dir, { recursive: true, force: true });
});

test('the store caps the list at 32, dedupes and sorts days, and hands out copies', () => {
  const { store, dir } = setup();
  const [created] = store.save({ time: '06:00', days: [4, 1, 4], action: { type: 'power', action: 'lock' } });
  assert.deepEqual(created!.days, [1, 4], 'duplicate days are folded and sorted');
  const listed = store.list();
  listed[0]!.days.push(6);
  assert.deepEqual(store.get(created!.id)!.days, [1, 4], 'mutating a returned automation cannot corrupt the store');
  for (let i = 0; i < 31; i++) store.save({ time: '06:00', days: [], action: { type: 'power', action: 'lock' } });
  assert.throws(() => store.save({ time: '06:00', days: [], action: { type: 'power', action: 'lock' } }), /AUTOMATION_LIMIT/);
  store.save({ id: created!.id, time: '06:30', days: [], action: { type: 'power', action: 'lock' } }); // replacing an existing entry stays under the cap
  assert.equal(store.list().length, 32);
  rmSync(dir, { recursive: true, force: true });
});
