import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationService, type AutomationExecutor } from '../src/automation/automation-service.js';
import { AutomationStore } from '../src/automation/automation-store.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ActivityLog } from '../src/activity-log/activity-log.js';

const SCENE = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-auto-edge-'));
  return { store: new AutomationStore(join(dir, 'automations.json')), dir, fired: [] as unknown[] };
}
const at = (hours: number, minutes: number, day = 3): Date => new Date(2026, 9, 14 + (day - 3), hours, minutes, 5);

test('an enabled automation whose day does not match does not fire and is not marked', async () => {
  const { store, dir, fired } = setup();
  const exec: AutomationExecutor = { launchScene: async id => { fired.push(id); }, launchApp: async () => {}, power: async () => {} };
  const service = new AutomationService(new CommandRegistry(), store, exec, new ActivityLog(), () => at(9, 30, 4)); // Thursday
  const [a] = store.save({ time: '09:30', days: [3], action: { type: 'scene', sceneId: SCENE } });
  await service.tick();
  assert.deepEqual(fired, []);
  assert.equal(store.get(a!.id)!.lastFiredAt, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('a tick while an action is still running does not stack fires, and the next tick runs normally', async () => {
  const { store, dir, fired } = setup();
  let release!: () => void;
  const slow = new Promise<void>(r => { release = r; });
  const exec: AutomationExecutor = {
    launchScene: async id => { fired.push(['scene', id]); await slow; },
    launchApp: async id => { fired.push(['app', id]); },
    power: async () => {},
  };
  let now = at(9, 30);
  const service = new AutomationService(new CommandRegistry(), store, exec, new ActivityLog(), () => now);
  store.save({ time: '09:30', days: [3], action: { type: 'scene', sceneId: SCENE } });
  store.save({ time: '09:30', days: [3], action: { type: 'app', appId: 'app-b' } });
  store.save({ time: '09:31', days: [3], action: { type: 'app', appId: 'app-c' } });
  const first = service.tick();
  await new Promise(r => setTimeout(r, 20)); // the slow scene action is now in flight
  await service.tick(); // must return without firing anything
  assert.deepEqual(fired, [['scene', SCENE]]);
  release();
  await first;
  assert.deepEqual(fired, [['scene', SCENE], ['app', 'app-b']]);
  now = at(9, 31);
  await service.tick();
  assert.deepEqual(fired, [['scene', SCENE], ['app', 'app-b'], ['app', 'app-c']]);
  rmSync(dir, { recursive: true, force: true });
});
