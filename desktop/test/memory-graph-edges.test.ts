/** Verifies memory ranking and limit edges the main suite leaves open: name words outrank fact words, the full-name bonus breaks ties, the alias cap is exact, and equal two-hop scores keep the first reason; depends on temp directories only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GraphStore } from '../src/memory/graph-store.js';

function store(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-graph-edges-')); const path = join(dir, 'memory.json');
  let now = 1_000;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { make: () => new GraphStore(path, () => ++now) };
}

test('a name word outranks the same word in a fact', t => {
  const s = store(t).make();
  const named = s.remember('quantum club'); // created first, so a tie would favour the fact entity
  s.remember('plain notes');
  s.find('plain notes')!.facts.push({ text: 'quantum reference', source: 'chat', at: 1 });
  const hits = s.recall('quantum');
  assert.equal(hits[0]!.entity.id, named.id, 'name match ranks first even though it is older');
});

test('the full-name containment bonus breaks an otherwise even match', t => {
  const s = store(t).make();
  const exact = s.remember('orbital'); // older; without the bonus the longer name would tie and win on recency
  s.remember('orbital dynamics');
  const hits = s.recall('orbital');
  assert.equal(hits[0]!.entity.id, exact.id, 'the exact full-name match ranks first');
});

test('an entity keeps at most eight aliases', t => {
  const s = store(t).make();
  const a = s.remember('rahul');
  for (let i = 1; i <= 8; i++) s.alias(a.id, `nickname ${i}`);
  assert.throws(() => s.alias(a.id, 'nickname 9'), /MEMORY_LIMIT/);
});

test('an equal two-hop score keeps the first reason instead of flipping', t => {
  const s = store(t).make();
  const alpha = s.remember('alpha');
  const beta = s.remember('beta');
  const hub = s.remember('hub');
  s.relate(alpha.id, hub.id, 'leads');
  s.relate(beta.id, hub.id, 'backs');
  const hits = s.recall('alpha beta');
  const via = hits.find(hit => hit.entity.id === hub.id);
  assert.equal(via?.via, 'leads alpha', 'the first equal-scoring path explains the neighbour');
});
