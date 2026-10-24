/** Dictation engine provisioning: resolution order, platform gating, hash verification and the success path with injected assets; depends on temp dirs and the system tar; performs no network access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureEngine, resolveEnginePaths, ProvisionError, PINNED_ASSETS } from '../src/dictation/provision.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'orbit-provision-test-'));

function fakeAssets(payload: Buffer, modelBytes: Buffer, binaryRel = 'whisper-cli') {
  const build = { url: 'https://example.invalid/engine.tar.gz', sha256: sha(payload), file: 'engine.tar.gz', binaryRel };
  return { model: { url: 'https://example.invalid/model.bin', sha256: sha(modelBytes), file: 'model.bin' }, builds: { 'linux-x64': build, 'win32-x64': build, 'darwin-arm64': build } };
}

test('resolveEnginePaths prefers the env pair, then the provisioned pair, then nothing', () => {
  const dir = tmp();
  const bin = join(dir, 'bin'); const model = join(dir, 'model');
  writeFileSync(bin, 'x'); writeFileSync(model, 'y');
  assert.deepEqual(resolveEnginePaths({ ORBIT_WHISPER_BIN: bin, ORBIT_WHISPER_MODEL: model }, join(dir, 'nope')), { binary: bin, model });
  assert.equal(resolveEnginePaths({}, join(dir, 'nope')), undefined);
  const data = tmp();
  const build = PINNED_ASSETS.builds[`${process.platform}-${process.arch}`];
  if (build) {
    mkdirSync(join(data, 'dictation', 'engine', ...(process.platform === 'win32' ? ['Release'] : [])), { recursive: true });
    writeFileSync(join(data, 'dictation', 'engine', build.binaryRel), 'x');
    writeFileSync(join(data, 'dictation', PINNED_ASSETS.model.file), 'y');
    assert.deepEqual(resolveEnginePaths({}, data), { binary: join(data, 'dictation', 'engine', build.binaryRel), model: join(data, 'dictation', PINNED_ASSETS.model.file) });
  }
});

test('ensureEngine rejects an unsupported platform without downloading', async () => {
  let fetched = 0;
  await assert.rejects(
    ensureEngine({ platform: 'freebsd', arch: 'riscv64', dataDir: tmp(), fetchImpl: async () => { fetched++; }, assets: fakeAssets(Buffer.from('a'), Buffer.from('b')) }),
    (e: unknown) => e instanceof ProvisionError && e.code === 'UNSUPPORTED_PLATFORM');
  assert.equal(fetched, 0);
});

test('ensureEngine refuses a corrupt engine download (hash mismatch) and never touches the model', async () => {
  const assets = fakeAssets(Buffer.from('real engine'), Buffer.from('real model'));
  await assert.rejects(
    ensureEngine({ platform: 'linux', arch: 'x64', dataDir: tmp(), assets, fetchImpl: async (_u, d) => writeFileSync(d, 'tampered') }),
    (e: unknown) => e instanceof ProvisionError && e.code === 'HASH_MISMATCH');
});

test('ensureEngine refuses a corrupt model download', async () => {
  const engineTar = join(tmp(), 'engine.tar.gz');
  const stage = join(tmp(), 'payload'); mkdirSync(stage);
  writeFileSync(join(stage, 'whisper-cli'), '#!/bin/sh\necho fake\n');
  execFileSync('tar', ['-czf', engineTar, '-C', stage, 'whisper-cli']);
  const assets = fakeAssets(Buffer.alloc(0), Buffer.from('real model'));
  assets.builds['linux-x64'].sha256 = sha(readFileSync(engineTar));
  await assert.rejects(
    ensureEngine({ platform: 'linux', arch: 'x64', dataDir: tmp(), assets, fetchImpl: async (u, d) => writeFileSync(d, u.includes('model') ? 'tampered' : readFileSync(engineTar)) }),
    (e: unknown) => e instanceof ProvisionError && e.code === 'HASH_MISMATCH');
});

test('ensureEngine downloads, verifies, extracts and reports engine+model paths', async () => {
  const stage = join(tmp(), 'payload'); mkdirSync(stage);
  writeFileSync(join(stage, 'whisper-cli'), '#!/bin/sh\necho fake\n');
  const engineTar = join(tmp(), 'engine.tar.gz');
  execFileSync('tar', ['czf', engineTar, '-C', stage, 'whisper-cli']);
  const engineBytes = Buffer.from(execFileSync('cat', [engineTar]));
  const modelBytes = Buffer.from('tiny model bytes');
  const assets = fakeAssets(engineBytes, modelBytes);
  const dataDir = tmp();
  const stages: string[] = [];
  const paths = await ensureEngine({ platform: 'linux', arch: 'x64', dataDir, assets,
    fetchImpl: async (u, d) => writeFileSync(d, u.includes('model') ? modelBytes : engineBytes), onStage: s => stages.push(s) });
  assert.equal(paths.binary, join(dataDir, 'dictation', 'engine', 'whisper-cli'));
  assert.equal(paths.model, join(dataDir, 'dictation', 'model.bin'));
  assert.ok(existsSync(paths.binary) && existsSync(paths.model));
  assert.deepEqual(stages, ['engine', 'verify', 'model', 'done']);
  // A second call resolves the provisioned pair without any download.
  let fetched = 0;
  const again = await ensureEngine({ platform: 'linux', arch: 'x64', dataDir, assets, fetchImpl: async () => { fetched++; } });
  assert.deepEqual(again, paths);
  assert.equal(fetched, 0);
  rmSync(dataDir, { recursive: true, force: true });
});

test('env override skips provisioning entirely even when nothing is downloaded yet', async () => {
  const dir = tmp();
  const bin = join(dir, 'my-whisper'); const model = join(dir, 'my-model');
  writeFileSync(bin, 'x'); writeFileSync(model, 'y');
  const paths = await ensureEngine({ env: { ORBIT_WHISPER_BIN: bin, ORBIT_WHISPER_MODEL: model }, dataDir: join(dir, 'data'), fetchImpl: async () => { throw new Error('must not download'); } });
  assert.deepEqual(paths, { binary: bin, model });
});
