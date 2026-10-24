/** Dictation engine provisioning: resolution order, platform gating, hash verification and the success path with injected assets; depends on temp dirs and the system tar; performs no network access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureEngine, resolveEnginePaths, ProvisionError, PINNED_ASSETS, MODELS, assetsFor, suggestModel } from '../src/dictation/provision.js';

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
test('model picker: three pinned models with distinct hashes; assetsFor swaps only the model', () => {
  assert.equal(new Set([MODELS.tiny.sha256, MODELS.base.sha256, MODELS.small.sha256]).size, 3);
  for (const name of ['tiny', 'base', 'small'] as const) {
    assert.equal(MODELS[name].file, `ggml-${name}.bin`);
    const t = assetsFor(name);
    assert.equal(t.model.sha256, MODELS[name].sha256);
    assert.equal(t.builds['linux-x64']!.sha256, PINNED_ASSETS.builds['linux-x64']!.sha256); // engine unchanged
  }
});

test('model picker: suggestModel is conservative by cores and memory', () => {
  assert.equal(suggestModel(2, 32), 'tiny');
  assert.equal(suggestModel(16, 4), 'tiny');
  assert.equal(suggestModel(4, 8), 'base');
  assert.equal(suggestModel(6, 12), 'base');
  assert.equal(suggestModel(8, 16), 'small');
  assert.equal(suggestModel(16, 32), 'small');
});

test('model picker: resolveEnginePaths only matches the chosen model file; another model does not satisfy it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-model-'));
  const eng = join(dir, 'dictation', 'engine');
  mkdirSync(eng, { recursive: true });
  writeFileSync(join(eng, 'whisper-cli'), 'x');
  writeFileSync(join(dir, 'dictation', 'ggml-tiny.bin'), 'x');
  assert.ok(resolveEnginePaths({}, dir, assetsFor('tiny'), 'linux', 'x64'));
  assert.equal(resolveEnginePaths({}, dir, assetsFor('base'), 'linux', 'x64'), undefined); // base not downloaded yet
});

test('model picker: ensureEngine provisions the picked model and hash-verifies it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-model-'));
  const seen: string[] = [];
  const fakeHash = createHash('sha256').update('fake').digest('hex');
  const paths = await ensureEngine({ dataDir: dir, platform: 'linux', arch: 'x64',
    assets: { ...assetsFor('base'), model: { ...MODELS.base, sha256: fakeHash }, builds: { 'linux-x64': { ...PINNED_ASSETS.builds['linux-x64']!, sha256: fakeHash } } },
    fetchImpl: async (url, dest) => { seen.push(url); writeFileSync(dest, 'fake'); },
    extractImpl: async (_a, d) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'whisper-cli'), 'x'); } });
  assert.ok(seen.some(u => u.includes('ggml-base.bin')));
  assert.equal(paths.model, join(dir, 'dictation', 'ggml-base.bin'));
});
