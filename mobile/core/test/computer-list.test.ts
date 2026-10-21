/** The multi-computer list rules that used to live untested in the app's secure-store glue; pure functions over the pairing schema. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PairedDesktop } from '../src/protocol.js';
import { MAX_COMPUTERS, chooseActive, migrateSingle, parseComputerList, removeComputer, rewriteComputer,
  serializeComputerList, upsertComputer } from '../src/computer-list.js';

const desktop = (n: number): PairedDesktop => ({
  desktopServiceId: `00000000-0000-4000-8000-00000000000${n}`,
  displayName: `PC ${n}`,
  deviceId: `11111111-1111-4111-8111-11111111111${n}`,
  endpoint: `wss://192.168.137.${n}:9123/v1/channel`,
  certificateFingerprint: 'ab'.repeat(32),
  credential: 'a'.repeat(43),
});

test('a missing or corrupt stored blob parses as nothing, so the migration path runs', () => {
  assert.equal(parseComputerList(undefined), undefined);
  assert.equal(parseComputerList(null), undefined);
  assert.equal(parseComputerList(''), undefined);
  assert.equal(parseComputerList('not json'), undefined);
  assert.equal(parseComputerList('{"not":"a list"}'), undefined);
  assert.equal(parseComputerList(JSON.stringify([{ bad: 'record' }])), undefined);
  assert.deepEqual(parseComputerList(JSON.stringify([desktop(1)])), [desktop(1)], 'a valid blob parses');
});

test('serializeComputerList round-trips and refuses a ninth computer or a bad record', () => {
  const eight = Array.from({ length: MAX_COMPUTERS }, (_, i) => desktop(i + 1));
  assert.deepEqual(parseComputerList(serializeComputerList(eight)), eight);
  assert.throws(() => serializeComputerList([...eight, desktop(9)]), /too big|Too big|max|Max/, 'the ninth computer must not silently persist');
  assert.throws(() => serializeComputerList([{ bad: 'record' } as unknown as PairedDesktop]));
});

test('chooseActive keeps a live active id and falls back to the first computer', () => {
  const list = [desktop(1), desktop(2)];
  assert.equal(chooseActive(list, list[1]!.desktopServiceId), list[1]!.desktopServiceId);
  assert.equal(chooseActive(list, '00000000-0000-4000-8000-999999999999'), list[0]!.desktopServiceId, 'a stale id falls back to the first');
  assert.equal(chooseActive(list, undefined), list[0]!.desktopServiceId);
  assert.equal(chooseActive(list, null), list[0]!.desktopServiceId);
  assert.equal(chooseActive([], undefined), undefined);
});

test('the single-record migration yields one active computer', () => {
  const single = desktop(1);
  const migrated = migrateSingle(single);
  assert.deepEqual(migrated, { list: [single], activeId: single.desktopServiceId });
});

test('upsert adds a new computer and makes it active; re-pairing replaces in place', () => {
  const first = desktop(1);
  const second = desktop(2);
  const withTwo = upsertComputer(upsertComputer([], first), second);
  assert.equal(withTwo.length, 2);
  const renewed = { ...second, endpoint: 'wss://192.168.137.99:9123/v1/channel' };
  const replaced = upsertComputer(withTwo, renewed);
  assert.equal(replaced.length, 2, 're-pairing must not grow the list');
  assert.deepEqual(replaced.find(d => d.desktopServiceId === second.desktopServiceId), renewed);
  assert.deepEqual(replaced[0], first, 'the other computer is untouched');
});

test('rewriteComputer updates the matching record only and reports unknown computers', () => {
  const list = [desktop(1), desktop(2)];
  const moved = { ...list[0]!, endpoint: 'wss://192.168.137.55:9123/v1/channel' };
  const next = rewriteComputer(list, moved);
  assert.deepEqual(next, [moved, list[1]!]);
  assert.equal(rewriteComputer(list, desktop(9)), undefined, 'unknown computer: caller must not persist anything');
});

test('removeComputer switches the active computer only when the active one went away', () => {
  const list = [desktop(1), desktop(2), desktop(3)];
  const activeId = list[1]!.desktopServiceId;
  const removedActive = removeComputer(list, activeId, activeId);
  assert.deepEqual(removedActive.list, [list[0]!, list[2]!]);
  assert.equal(removedActive.activeId, list[0]!.desktopServiceId, 'first remaining becomes active');
  const removedOther = removeComputer(list, list[0]!.desktopServiceId, activeId);
  assert.equal(removedOther.activeId, activeId, 'removing a background computer keeps the active one');
  const removedLast = removeComputer([desktop(1)], list[0]!.desktopServiceId, list[0]!.desktopServiceId);
  assert.deepEqual(removedLast, { list: [], activeId: undefined }, 'the last computer leaves no active id');
  const removedUnknown = removeComputer(list, '00000000-0000-4000-8000-999999999999', activeId);
  assert.deepEqual(removedUnknown, { list, activeId }, 'an unknown id changes nothing');
});
