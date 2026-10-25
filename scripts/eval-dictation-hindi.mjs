// Run: MODELS=tiny,base,small node scripts/eval-dictation-hindi.mjs (needs whisper-cli build + ggml models + FLEURS hi_in test clips; see docs/dictation.md)
/** FLEURS hi_in (CC-BY-4.0, Google FLEURS dataset, test split) through the repo's REAL wav parser,
    pipeline and whisper-cli with each pinned model. Bounded sample of 10 clips; reports per-model
    exact/normalized matches and WER against the dataset's normalized references. Not a Hinglish
    (code-mixed) measurement: these are read Hindi sentences. */
import { wavToPcm16k } from '../mobile/core/dist/src/wav.js';
import { WhisperCpp } from '../desktop/dist/src/dictation/whisper-cpp.js';
import { dictate } from '../desktop/dist/src/dictation/pipeline.js';
import { readFileSync } from 'node:fs';

const BIN = process.env.WHISPER_BIN || '/tmp/whisper.cpp/build/bin/whisper-cli';
const rows = readFileSync(process.env.FLEURS_TSV || '/tmp/fleurs-hi-test.tsv', 'utf8').split('\n').filter(Boolean).slice(Number(process.env.OFF || 0), Number(process.env.OFF || 0) + Number(process.env.N || 10))
  .map(l => { const c = l.split('\t'); return { file: c[1], ref: c[3] }; });

const norm = s => s.normalize('NFC').replace(/[।,.\-!?()"']/g, ' ').replace(/\s+/g, ' ').trim();
const wer = (ref, hyp) => {
  const r = norm(ref).split(' '), h = norm(hyp).split(' ');
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (r[i-1] === h[j-1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
};

for (const model of (process.env.MODELS || 'tiny,base,small').split(',')) {
  const eng = new WhisperCpp({ binary: BIN, model: `${process.env.MODEL_DIR || '/tmp'}/ggml-${model}.bin`, threads: 8 });
  let exact = 0, wers = [], done = 0;
  for (const { file, ref } of rows) {
    const pcm = wavToPcm16k(new Uint8Array(readFileSync(`${process.env.FLEURS_DIR || '/tmp/fleurs-hi16'}/${file}`)));
    const r = await dictate(pcm, eng, { language: 'hi', signal: new AbortController().signal });
    if (r.status === 'text') {
      done++;
      if (norm(r.text) === norm(ref)) exact++;
      wers.push(wer(ref, r.text));
    } else { wers.push(1); console.log(`  [${model}] ${file}: ${r.status}`); }
  }
  const avg = wers.reduce((a, b) => a + b, 0) / wers.length;
  console.log(`${model}: transcribed=${done}/10 exact=${exact}/10 avgWER=${(avg * 100).toFixed(1)}%`);
}
