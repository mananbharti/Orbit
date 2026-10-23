/** Audit-trail edges the routed suite does not pin: the compaction boundary, pre-existing loose file permissions and record validation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuditTrail, MAX_AUDIT_ENTRIES } from '../src/agent/audit-trail.js';

const dir = (t: test.TestContext) => { const d = mkdtempSync(join(tmpdir(), 'orbit-audit-edge-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('compaction fires exactly once the file passes the retention size plus its 200-entry hysteresis', t => {
  const directory = dir(t); const trail = new AuditTrail(directory); const device = randomUUID();
  const file = join(directory, 'agent-audit.jsonl');
  for (let i = 0; i < MAX_AUDIT_ENTRIES + 200; i++) trail.record({ deviceId: device, kind: 'paused' });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, MAX_AUDIT_ENTRIES + 200, 'not compacted yet');
  trail.record({ deviceId: device, kind: 'paused' });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, MAX_AUDIT_ENTRIES, 'compacted back to the retention size');
});
test('a pre-existing audit file with loose permissions is tightened on open', { skip: process.platform === 'win32' && 'file modes do not exist on Windows' }, t => {
  const directory = dir(t);
  writeFileSync(join(directory, 'agent-audit.jsonl'), '', { mode: 0o644 });
  new AuditTrail(directory);
  assert.equal(statSync(join(directory, 'agent-audit.jsonl')).mode & 0o777, 0o600);
});
test('an entry that does not fit the audit schema is refused, not written', t => {
  const directory = dir(t); const trail = new AuditTrail(directory);
  assert.equal(trail.record({ deviceId: randomUUID(), kind: 'made-up' as never }), false);
  assert.equal(trail.record({ deviceId: 'not-a-uuid', kind: 'paused' }), false);
  assert.equal(trail.record({ deviceId: randomUUID(), kind: 'finished', outcome: 'x'.repeat(33) }), false);
  assert.equal(readFileSync(join(directory, 'agent-audit.jsonl'), 'utf8'), '');
  assert.equal(trail.record({ deviceId: randomUUID(), kind: 'finished', outcome: 'x'.repeat(32) }), true);
});
