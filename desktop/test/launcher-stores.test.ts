/** Pins launcher favourites and scenes store rules directly: caps, copy semantics, reorder validation, persistence, oversized files; depends on a temp directory only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LauncherLayout } from '../src/app-launcher/launcher-layout.js';
import { LauncherScenes } from '../src/app-launcher/launcher-scenes.js';
import { MAX_PINS, MAX_SCENES } from '../src/protocol/app-launcher.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const dir = (t: test.TestContext) => { const d = mkdtempSync(join(tmpdir(), 'orbit-launcher-stores-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('pins cap at the limit, repeat pins are idempotent, unpin persists, and list hands out copies', t => {
  const path = join(dir(t), 'layout.json');
  const layout = new LauncherLayout(path);
  for (let i = 0; i < MAX_PINS; i++) layout.pin(id(i));
  assert.throws(() => layout.pin(id(999)), /LAUNCHER_PIN_LIMIT/);
  assert.equal(layout.pin(id(0)).length, MAX_PINS, 'an already pinned app is not an error at the cap');
  const copy = layout.list();
  copy.length = 0;
  assert.equal(layout.list().length, MAX_PINS);
  layout.unpin(id(3));
  assert.equal(layout.unpin(id(12345)).length, MAX_PINS - 1);
  const reloaded = new LauncherLayout(path).list();
  assert.equal(reloaded.length, MAX_PINS - 1);
  assert.ok(!reloaded.includes(id(3)));
});

test('reorder must name every pinned id exactly once and persists the new order', t => {
  const path = join(dir(t), 'layout.json');
  const layout = new LauncherLayout(path);
  layout.pin(id(1)); layout.pin(id(2)); layout.pin(id(3));
  const stale = /LAUNCHER_STALE_LAYOUT/;
  assert.throws(() => layout.reorder([id(1), id(2)]), stale, 'missing one');
  assert.throws(() => layout.reorder([id(1), id(2), id(3), id(4)]), stale, 'extra one');
  assert.throws(() => layout.reorder([id(1), id(1), id(2)]), stale, 'duplicate replacing one');
  assert.throws(() => layout.reorder([id(1), id(2), id(9)]), stale, 'unknown one');
  assert.deepEqual(layout.list(), [id(1), id(2), id(3)], 'a rejected reorder changes nothing');
  assert.deepEqual(layout.reorder([id(3), id(1), id(2)]), [id(3), id(1), id(2)]);
  assert.deepEqual(new LauncherLayout(path).list(), [id(3), id(1), id(2)]);
});

test('a layout file with too many pins or a bad id is rejected whole', t => {
  const path = join(dir(t), 'layout.json');
  writeFileSync(path, JSON.stringify(Array.from({ length: MAX_PINS + 1 }, (_, i) => id(i))));
  assert.deepEqual(new LauncherLayout(path).list(), []);
  writeFileSync(path, JSON.stringify([id(1), 'not-an-id']));
  assert.deepEqual(new LauncherLayout(path).list(), []);
});

test('scenes cap at the limit, hand out copies, never alias caller arrays, and persist edits and deletes', t => {
  const path = join(dir(t), 'scenes.json');
  const scenes = new LauncherScenes(path);
  const ids = [id(1), id(2)];
  scenes.save('First', ids);
  ids[0] = id(77);
  assert.equal(scenes.list()[0]!.appIds[0], id(1), 'new scene copies the caller array');
  for (let i = 1; i < MAX_SCENES; i++) scenes.save(`Scene ${i}`, [id(i)]);
  assert.throws(() => scenes.save('One too many', [id(1)]), /LAUNCHER_SCENE_LIMIT/);
  const listed = scenes.list();
  listed[0]!.appIds.push(id(5)); listed[0]!.name = 'tampered';
  assert.equal(scenes.list()[0]!.name, 'First');
  assert.equal(scenes.list()[0]!.appIds.length, 2);
  const editIds = [id(8)];
  const editId = scenes.list()[1]!.id;
  scenes.save('Edited', editIds, editId);
  editIds[0] = id(99);
  assert.deepEqual(scenes.get(editId)!.appIds, [id(8)], 'an edit copies the caller array');
  scenes.remove(scenes.list()[2]!.id);
  assert.equal(scenes.remove('00000000-0000-4000-8000-000000000000').length, MAX_SCENES - 1);
  const reloaded = new LauncherScenes(path).list();
  assert.equal(reloaded.length, MAX_SCENES - 1);
  assert.equal(reloaded[1]!.name, 'Edited');
});

test('a scenes file with too many scenes is rejected whole', t => {
  const path = join(dir(t), 'scenes.json');
  const many = Array.from({ length: MAX_SCENES + 1 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `S${i}`, appIds: [id(i)] }));
  writeFileSync(path, JSON.stringify(many));
  assert.deepEqual(new LauncherScenes(path).list(), []);
});

test('each pin and each scene save is written to disk on its own', t => {
  const folder = dir(t);
  const layout = new LauncherLayout(join(folder, 'layout.json'));
  layout.pin(id(1));
  assert.deepEqual(new LauncherLayout(join(folder, 'layout.json')).list(), [id(1)]);
  const scenes = new LauncherScenes(join(folder, 'scenes.json'));
  scenes.save('Only', [id(1)]);
  assert.equal(new LauncherScenes(join(folder, 'scenes.json')).list()[0]!.name, 'Only');
});

test('reorder refuses a same-size list that swaps a pinned id for an unpinned one', () => {
  const layout = new LauncherLayout();
  layout.pin(id(1)); layout.pin(id(2));
  assert.throws(() => layout.reorder([id(1), id(9)]), /LAUNCHER_STALE_LAYOUT/);
  assert.deepEqual(layout.list(), [id(1), id(2)]);
});
