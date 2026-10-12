/** Phone side of dictation: streams one recorded clip to the paired computer and returns its text; depends on OrbitSession; keeps no audio after the call. */
import { toBase64 } from './base64.js';
import { InvalidDesktopReply } from './agent.js';
import { DICTATION_CHUNK_SAMPLES, MAX_DICTATION_SAMPLES, dictationBeginSchema, dictationChunkSchema, dictationResultSchema, type DictationResult } from './protocol.js';
import { NotSent, type OrbitSession } from './session.js';

export class DictationApi {
  private busy = false;
  constructor(private readonly session: OrbitSession) {}

  /** `pcm` must be 16 kHz mono signed 16-bit samples. It is zeroed when the call ends, whatever the outcome. */
  async transcribe(pcm: Int16Array, language?: string): Promise<DictationResult> {
    if (this.busy) { throw new NotSent('Already transcribing'); }
    if (pcm.length === 0) throw new NotSent('Nothing was recorded');
    if (pcm.length > MAX_DICTATION_SAMPLES) throw new NotSent('That recording is too long (limit 2 minutes)');
    this.busy = true;
    let id: string | undefined;
    try {
      const begun = dictationBeginSchema.safeParse(await this.session.command('dictation.begin', language ? { language } : {}));
      if (!begun.success) throw new InvalidDesktopReply();
      id = begun.data.dictationId;
      for (let offset = 0; offset < pcm.length; offset += DICTATION_CHUNK_SAMPLES) {
        const part = pcm.subarray(offset, Math.min(pcm.length, offset + DICTATION_CHUNK_SAMPLES));
        const bytes = new Uint8Array(part.length * 2);
        const view = new DataView(bytes.buffer);
        part.forEach((s, i) => view.setInt16(i * 2, s, true));
        const ack = dictationChunkSchema.safeParse(await this.session.command('dictation.chunk', { dictationId: id, offset, dataBase64: toBase64(bytes) }));
        bytes.fill(0);
        if (!ack.success || ack.data.nextOffset !== offset + part.length) throw new InvalidDesktopReply();
      }
      const result = dictationResultSchema.safeParse(await this.session.command('dictation.finish', { dictationId: id }, { timeoutMs: 120_000 }));
      if (!result.success) throw new InvalidDesktopReply();
      id = undefined;
      return result.data;
    } catch (error) {
      if (id) { try { await this.session.command('dictation.cancel', { dictationId: id }); } catch { /* the computer drops it on timeout or disconnect */ } }
      throw error;
    } finally { pcm.fill(0); this.busy = false; }
  }
}
