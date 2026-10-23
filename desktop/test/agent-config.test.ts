/** The desktop app's Hermes settings file: validation, encrypted storage, corrupt-input behavior. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearAgentConfig, loadAgentConfig, saveAgentConfig, validateAgentConfig } from '../src/agent-config.js';

// Tests stand in for Electron safeStorage with a reversible transform; the contract is the same.
const enc = (s: string): string => Buffer.from(`enc:${s}`).toString('base64');
const dec = (s: string): string => { const t = Buffer.from(s, 'base64').toString(); if (!t.startsWith('enc:')) throw new Error('bad blob'); return t.slice(4); };

function dir(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), 'orbit-agent-config-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('validation: a pasted key survives trimming; junk is refused with a readable reason', () => {
  assert.deepEqual(validateAgentConfig({ apiKey: '  abc123  ' }), { apiKey: 'abc123' });
  assert.throws(() => validateAgentConfig({}), /Paste the API_SERVER_KEY/);
  assert.throws(() => validateAgentConfig({ apiKey: ' ' }), /Paste the API_SERVER_KEY/);
  assert.throws(() => validateAgentConfig({ apiKey: 'line1\nline2' }), /single line/);
  assert.throws(() => validateAgentConfig({ apiKey: 'x'.repeat(513) }), /too long/);
  assert.throws(() => validateAgentConfig({ apiKey: 'k', baseUrl: 'not a url' }), /not a valid URL/);
  assert.throws(() => validateAgentConfig({ apiKey: 'k', baseUrl: 'ftp://127.0.0.1' }), /http or https/);
  assert.deepEqual(validateAgentConfig({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8642' }), { apiKey: 'k', baseUrl: 'http://127.0.0.1:8642' });
});

test('roundtrip: the file holds only the encrypted blob, never the plaintext key', t => {
  const path = join(dir(t), 'orbit-agent.json');
  saveAgentConfig(path, { apiKey: 'super-secret-key', baseUrl: 'http://127.0.0.1:8642' }, enc);
  const onDisk = readFileSync(path, 'utf8');
  assert.ok(!onDisk.includes('super-secret-key')); // no plaintext at rest
  assert.deepEqual(loadAgentConfig(path, dec), { apiKey: 'super-secret-key', baseUrl: 'http://127.0.0.1:8642' });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600, 'file is owner-only');
});

test('load: missing, corrupt, undecryptable or invalid files all mean "agent off", never a crash', t => {
  const d = dir(t);
  assert.equal(loadAgentConfig(join(d, 'nope.json'), dec), undefined);
  const corrupt = join(d, 'corrupt.json'); writeFileSync(corrupt, '{not json');
  assert.equal(loadAgentConfig(corrupt, dec), undefined);
  const badBlob = join(d, 'bad.json'); writeFileSync(badBlob, JSON.stringify({ v: 1, key: '!!!' }));
  assert.equal(loadAgentConfig(badBlob, dec), undefined);
  const badKey = join(d, 'badkey.json'); writeFileSync(badKey, JSON.stringify({ v: 1, key: enc('with\nnewline') }));
  assert.equal(loadAgentConfig(badKey, dec), undefined);
  const wrongVersion = join(d, 'v2.json'); writeFileSync(wrongVersion, JSON.stringify({ v: 2, key: enc('k') }));
  assert.equal(loadAgentConfig(wrongVersion, dec), undefined);
});

test('clear removes the settings; clearing twice is fine', t => {
  const path = join(dir(t), 'orbit-agent.json');
  saveAgentConfig(path, { apiKey: 'k' }, enc);
  clearAgentConfig(path);
  assert.equal(loadAgentConfig(path, dec), undefined);
  clearAgentConfig(path); // no throw
});
