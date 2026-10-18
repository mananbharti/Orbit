/** Verifies the owner-run audit export CLI: csv/json output, usage and missing-file exits; depends on the built CLI and temp directories only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { AuditTrail } from '../src/agent/audit-trail.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/agent/export-audit.js');
const DEVICE = '123e4567-e89b-42d3-a456-426614174000';

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? -1, stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') };
  }
}

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-audit-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('exports recorded entries as csv by default and json on request', t => {
  const directory = fixture(t);
  const trail = new AuditTrail(directory);
  assert.ok(trail.record({ deviceId: DEVICE, kind: 'submitted' }));
  assert.ok(trail.record({ deviceId: DEVICE, kind: 'finished', outcome: 'success' }));
  const csv = run([directory]);
  assert.equal(csv.status, 0, csv.stderr);
  assert.match(csv.stdout, /submitted/);
  assert.match(csv.stdout, /finished/);
  const json = run([directory, 'json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as { deviceId: string; kind: string }[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.deviceId, DEVICE);
  assert.deepEqual(parsed.map(entry => entry.kind), ['submitted', 'finished']);
});

test('a directory without an audit log exits 1 with a clear message', t => {
  const result = run([fixture(t)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No agent audit log found/);
});

test('bad usage exits 2 and never touches the network', t => {
  assert.equal(run([]).status, 2);
  assert.equal(run([fixture(t), 'yaml']).status, 2);
});
