import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GraphStore, MAX_FACTS_PER_ENTITY } from '../src/memory/graph-store.js';

function store(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-graph-')); const path = join(dir, 'memory.json');
  let now = 1_000;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { path, make: () => new GraphStore(path, () => ++now) };
}

test('entities are found by name or alias, case-insensitively, without duplicates', t => {
  const s = store(t).make();
  const a = s.remember('Rahul Sharma', 'person');
  assert.equal(s.remember('rahul sharma').id, a.id);
  s.alias(a.id, 'Rahul bhai');
  assert.equal(s.find('RAHUL BHAI')?.id, a.id);
  const b = s.remember('Sam', 'person');
  assert.throws(() => s.alias(b.id, 'rahul bhai'), /ALIAS_IN_USE/);
  assert.equal(s.size(), 2);
});
test('recall ranks name matches over fact matches and pulls in neighbours with the reason', t => {
  const s = store(t).make();
  const rahul = s.remember('Rahul', 'person'); const orbit = s.remember('Orbit 1.0', 'project'); const mst = s.remember('MST exam', 'event');
  s.addFact(rahul.id, 'prefers WhatsApp in Hinglish'); s.addFact(orbit.id, 'Rahul reviews the security design');
  s.relate(rahul.id, mst.id, 'studies-for');
  const hits = s.recall('what does Rahul prefer');
  assert.equal(hits[0]!.entity.name, 'Rahul');
  assert.ok(hits.some(h => h.entity.name === 'Orbit 1.0'), 'fact match');
  const mstHit = hits.find(h => h.entity.name === 'MST exam');
  assert.equal(mstHit?.via, 'studies-for Rahul');
  assert.deepEqual(s.recall('nothing relevant zzz'), []);
});
test('memory persists, is private, and a restart sees the same graph', t => {
  const f = store(t); const s = f.make();
  const a = s.remember('Orbit', 'project'); s.addFact(a.id, 'uses pinned TLS', 'chat'); s.relate(a.id, s.remember('Hermes', 'tool').id, 'uses');
  // POSIX permission bits do not exist on Windows; there the file is protected by the private directory's ACL instead.
  if (process.platform !== 'win32') assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const again = f.make();
  assert.equal(again.size(), 2);
  assert.equal(again.find('Orbit')?.facts[0]?.source, 'chat');
  assert.equal(again.recall('hermes')[0]!.entity.name, 'Hermes');
});
test('forget removes the entity, its facts and every relation to it', t => {
  const f = store(t); const s = f.make();
  const a = s.remember('A'); const b = s.remember('B'); s.relate(a.id, b.id, 'knows'); s.addFact(a.id, 'secret detail');
  assert.equal(s.forget(a.id), true); assert.equal(s.forget(a.id), false);
  const text = readFileSync(f.path, 'utf8');
  assert.ok(!text.includes('secret detail') && !text.includes('knows'));
  assert.deepEqual(f.make().recall('secret'), []);
});
test('duplicate facts are ignored and the oldest fact makes room at the limit', t => {
  const s = store(t).make(); const a = s.remember('Topic');
  s.addFact(a.id, 'Same fact'); s.addFact(a.id, 'same   FACT');
  assert.equal(s.find('Topic')!.facts.length, 1);
  for (let i = 0; i < MAX_FACTS_PER_ENTITY + 5; i++) s.addFact(a.id, `fact number ${i}`);
  const facts = s.find('Topic')!.facts;
  assert.equal(facts.length, MAX_FACTS_PER_ENTITY);
  assert.equal(facts.at(-1)!.text, `fact number ${MAX_FACTS_PER_ENTITY + 4}`);
});
test('hostile input is rejected and a corrupt file is set aside intact rather than fatal or overwritten', t => {
  const f = store(t); const s = f.make();
  assert.throws(() => s.remember('', 'x')); assert.throws(() => s.remember('ok', 'Bad Kind!')); assert.throws(() => s.remember('x'.repeat(81)));
  writeFileSync(f.path, '{"version":1,"entities":"nope"}');
  const recovered = f.make();
  assert.equal(recovered.size(), 0, 'one unreadable file never takes the desktop down: memory starts empty');
  const aside = readdirSync(dirname(f.path)).find(name => name.startsWith('memory.json.corrupt-'));
  assert.ok(aside, 'the unreadable file was set aside, not overwritten or deleted');
  assert.equal(readFileSync(join(dirname(f.path), aside), 'utf8'), '{"version":1,"entities":"nope"}', 'every byte preserved');
  recovered.remember('Still works', 'thing');
  assert.equal(recovered.size(), 1, 'the store is usable right away');
  writeFileSync(f.path, '{ not json at all');
  assert.equal(f.make().size(), 0, 'invalid JSON is handled the same way');
});
