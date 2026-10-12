/** Turns a recorded WAV file into the 16 kHz mono 16-bit samples dictation needs; depends on nothing; accepts only integer PCM and never trusts header sizes beyond the bytes it has. */
export class WavError extends Error { constructor(readonly code: 'NOT_WAV' | 'UNSUPPORTED' | 'EMPTY' | 'TOO_LONG') { super(code); } }
export const TARGET_RATE = 16_000;

export function wavToPcm16k(bytes: Uint8Array, maxSamples = TARGET_RATE * 120): Int16Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new WavError('NOT_WAV');
  let fmt: { channels: number; rate: number; bits: number; format: number } | undefined;
  let data: { start: number; end: number } | undefined;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o); const size = v.getUint32(o + 4, true); const start = o + 8;
    if (id === 'fmt ' && start + 16 <= bytes.length) {
      let format = v.getUint16(start, true);
      if (format === 0xfffe && size >= 26 && start + 26 <= bytes.length) format = v.getUint16(start + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { format, channels: v.getUint16(start + 2, true), rate: v.getUint32(start + 4, true), bits: v.getUint16(start + 14, true) };
    } else if (id === 'data') {
      // Recorders that stream often leave the size 0 or 0xFFFFFFFF: take what is there.
      const end = size === 0 || size === 0xffffffff || start + size > bytes.length ? bytes.length : start + size;
      data = { start, end }; break;
    }
    o = start + size + (size % 2);
  }
  if (!fmt || !data) throw new WavError('NOT_WAV');
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8_000 || fmt.rate > 96_000) throw new WavError('UNSUPPORTED');
  const frames = Math.floor((data.end - data.start) / (2 * fmt.channels));
  if (frames === 0) throw new WavError('EMPTY');
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += v.getInt16(data.start + (i * fmt.channels + c) * 2, true);
    mono[i] = sum / fmt.channels;
  }
  const outLen = Math.floor(frames * TARGET_RATE / fmt.rate);
  if (outLen === 0) throw new WavError('EMPTY');
  if (outLen > maxSamples) throw new WavError('TOO_LONG');
  const out = new Int16Array(outLen);
  const ratio = fmt.rate / TARGET_RATE;
  for (let i = 0; i < outLen; i++) { // linear interpolation; fine for speech, no anti-alias filter when downsampling
    const pos = i * ratio; const a = Math.floor(pos); const b = Math.min(a + 1, frames - 1); const f = pos - a;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(mono[a]! * (1 - f) + mono[b]! * f)));
  }
  mono.fill(0);
  return out;
}
