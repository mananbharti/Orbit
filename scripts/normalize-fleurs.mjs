// Converts FLEURS float32 wavs (format 3) to 16 kHz mono PCM16 wavs the repo parser accepts.
// Run: node scripts/normalize-fleurs.mjs <rawDir> <outDir> <file1> [file2...]
import { readFileSync, writeFileSync } from 'node:fs';
const [rawDir, outDir, ...files] = process.argv.slice(2);
for (const name of files) {
  const b = readFileSync(`${rawDir}/${name}`);
  if (b.readUInt32LE(0) !== 0x46464952 || b.readUInt32LE(8) !== 0x45564157) throw new Error('not wav: ' + name);
  let o = 12, fmt, data;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4), start = o + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), rate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14) };
    if (id === 'data') data = { start, end: Math.min(start + size, b.length) };
    o = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 3 || fmt.bits !== 32 || fmt.rate !== 16000 || fmt.channels !== 1) throw new Error(`unexpected fmt ${JSON.stringify(fmt)} for ${name}`);
  const n = Math.floor((data.end - data.start) / 4);
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(16000, 24);
  pcm.writeUInt32LE(32000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const f = Math.max(-1, Math.min(1, b.readFloatLE(data.start + i * 4)));
    pcm.writeInt16LE(Math.round(f * 32767), 44 + i * 2);
  }
  writeFileSync(`${outDir}/${name}`, pcm);
  console.log('normalized', name);
}
