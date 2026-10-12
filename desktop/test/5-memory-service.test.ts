import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { CommandContext } from '../src/command-router/command-context.js';
import { GraphStore } from '../src/memory/graph-store.js';
import { MemoryService } from '../src/memory/memory-service.js';
import { isCommandAllowed } from '../src/security-pairing/scopes.js';

function setup(t: { after(f: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-mem-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new CommandRegistry(); const service = new MemoryService(registry, new GraphStore(join(dir, 'm.json')), new ActivityLog());
  const ctx = (authorized: boolean) => ({ session: {}, requestId: 'r', connection: { id: 'c', closed: new AbortController().signal, isAuthorized: () => authorized, publish() {} } }) as unknown as CommandContext;
  const call = (type: string, p: object, authorized = true) => registry.get(type)!.execute(p as never, ctx(authorized));
  return { registry, service, call };
}

test('remember, recall and forget work end to end through the command registry', async t => {
  const { call, registry } = setup(t);
  const r = await call('memory.remember', { name: 'Rahul', kind: 'person', fact: 'likes Hinglish', relatedTo: 'Orbit', relation: 'works-on' }) as { id: string };
  const out = await call('memory.recall', { query: 'rahul' }) as { results: { name: string; facts: string[] }[] };
  assert.equal(out.results[0]!.name, 'Rahul'); assert.deepEqual(out.results[0]!.facts, ['likes Hinglish']);
  assert.ok(out.results.some(x => x.name === 'Orbit'));
  assert.deepEqual(await call('memory.forget', { id: r.id }), { removed: true });
  assert.deepEqual(await call('memory.recall', { query: 'rahul' }), { results: [] });
  assert.equal(registry.get('memory.remember')!.validate({ name: 'x', extra: 1 } as never), false);
});
test('unauthenticated callers and bad input are rejected with safe errors', async t => {
  const { call } = setup(t);
  await assert.rejects(() => call('memory.recall', { query: 'x' }, false), /UNAUTHENTICATED/);
  await assert.rejects(() => call('memory.remember', { name: '   ' }), /INVALID_PAYLOAD/);
  await assert.rejects(() => call('memory.remember', { name: 'ok', kind: 'Bad Kind' }), /INVALID_PAYLOAD/);
});
test('memory is its own permission scope', () => {
  assert.equal(isCommandAllowed(['agent'], 'memory.recall'), false);
  assert.equal(isCommandAllowed(['memory'], 'memory.recall'), true);
  assert.equal(isCommandAllowed(undefined, 'memory.recall'), true);
});
