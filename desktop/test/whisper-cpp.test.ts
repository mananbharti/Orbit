import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DictationError } from '../src/dictation/pipeline.js';
import { WhisperCpp, wavBytes, defaultEngineTimeoutMs } from '../src/dictation/whisper-cpp.js';

const fake = (script: string): { binary: string; model: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-whisper-'));
  const binary = join(dir, 'whisper-cli'); writeFileSync(binary, `#!/bin/sh\n${script}\n`); chmodSync(binary, 0o755);
  const model = join(dir, 'model.bin'); writeFileSync(model, 'x');
  return { binary, model, dir };
};
// The fake engine is a #!/bin/sh script, which Windows cannot run. Real whisper.cpp on Windows is still untested.
const posixOnly = { skip: process.platform === 'win32' ? 'needs a POSIX shell for the fake engine' : false };
const leftovers = (): string[] => readdirSync(tmpdir()).filter(n => n.startsWith('orbit-dictation-'));

test('default engine timeout scales for large/turbo models and respects an explicit override', () => {
  assert.equal(defaultEngineTimeoutMs('/data/dictation/ggml-tiny.bin'), 60_000);
  assert.equal(defaultEngineTimeoutMs('/data/dictation/ggml-small.bin'), 60_000);
  assert.equal(defaultEngineTimeoutMs('/data/dictation/ggml-large-v3-turbo-q5_0.bin'), 115_000);
});

test('wav header is a valid 16 kHz mono PCM header', () => {
  const w = wavBytes(Int16Array.from([1, 2, 3]));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.readUInt32LE(24), 16_000); assert.equal(w.readUInt32LE(40), 6); assert.equal(w.length, 50);
});
test('runs the local binary with the clip, returns its text, and leaves no temp file', posixOnly, async () => {
  const f = fake('echo "  hello from fake  "; for a in "$@"; do [ "$a" = "-f" ] && USE=1 && continue; [ -n "$USE" ] && test -s "$a" && echo seen >&2; USE=; done');
  const before = leftovers().length;
  const text = await new WhisperCpp(f).transcribe(new Int16Array(1600), { language: 'hi', signal: new AbortController().signal });
  assert.equal(text, 'hello from fake');
  assert.equal(leftovers().length, before);
});
test('a failing engine rejects and still cleans up', posixOnly, async () => {
  const f = fake('exit 3');
  const before = leftovers().length;
  await assert.rejects(new WhisperCpp(f).transcribe(new Int16Array(1600), { signal: new AbortController().signal }));
  assert.equal(leftovers().length, before);
});
test('missing binary or model, or a hostile language string, is refused', posixOnly, async () => {
  assert.throws(() => new WhisperCpp({ binary: '/nope', model: '/nope' }), (e: unknown) => e instanceof DictationError);
  const f = fake('echo hi');
  await assert.rejects(new WhisperCpp(f).transcribe(new Int16Array(10), { language: 'en; rm -rf /', signal: new AbortController().signal }));
  assert.equal(existsSync(f.model), true); assert.equal(readFileSync(f.model, 'utf8'), 'x');
});
