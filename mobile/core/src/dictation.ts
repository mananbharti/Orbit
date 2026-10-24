/** Phone side of dictation: streams one recorded clip to the paired computer and returns its text; depends on OrbitSession; keeps no audio after the call. */
import { toBase64 } from './base64.js';
import { InvalidDesktopReply } from './agent.js';
import { DICTATION_CHUNK_SAMPLES, MAX_COMPRESSED_BYTES, MAX_DICTATION_SAMPLES, dictationBeginSchema, dictationChunkSchema, dictationInsertOutcomeSchema, dictationResultSchema, dictationSetupStateSchema, type DictationInsertOutcome, type DictationResult, type DictationSetupState } from './protocol.js';
import { NotSent, type OrbitSession } from './session.js';

/** The pre-insert-offer result shape: callers written before confirm-to-insert see exactly what they always saw. */
const legacyResult = (result: DictationResult): DictationResult => result.status === 'text' ? { status: 'text', text: result.text } : result;

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
      id = undefined; // any insert offer is abandoned here; the next begin or the retention window drops it
      return legacyResult(result.data);
    } catch (error) {
      if (id) { try { await this.session.command('dictation.cancel', { dictationId: id }); } catch { /* the computer drops it on timeout or disconnect */ } }
      throw error;
    } finally { pcm.fill(0); this.busy = false; }
  }

  /** Like transcribe, but keeps the computer's confirm-to-insert offer open: when result.insertOffered is true, confirmInsert(dictationId) pastes the transcript into the window that was focused when the recording began. The offer expires with the computer's retention window or when any device dictates again. */
  async transcribeForInsert(pcm: Int16Array, language?: string): Promise<{ result: DictationResult; dictationId?: string }> {
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
      const data = result.data;
      const offered = data.status === 'text' && data.insertOffered === true;
      if (offered) return { result: data, dictationId: id };
      id = undefined;
      return { result: data };
    } catch (error) {
      if (id) { try { await this.session.command('dictation.cancel', { dictationId: id }); } catch { /* the computer drops it on timeout or disconnect */ } }
      throw error;
    } finally { pcm.fill(0); this.busy = false; }
  }

  /** Pastes the retained transcript into the captured focus target on the computer; one-shot, fixed outcome categories only. */
  async confirmInsert(dictationId: string): Promise<DictationInsertOutcome> {
    const parsed = dictationInsertOutcomeSchema.safeParse(await this.session.command('dictation.insert', { dictationId }));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.outcome;
  }

  /** Engine setup state on the computer: off / downloading / ready / failed. Throws NotSent on unknown-command desktops (older builds answer that way); callers treat that as ready and keep the old behavior. */
  async setupState(): Promise<DictationSetupState> {
    const parsed = dictationSetupStateSchema.safeParse(await this.session.command('dictation.status', {}));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  /** Cancels an in-flight engine download on the computer. Returns the new state. */
  async cancelSetup(): Promise<DictationSetupState> {
    const parsed = dictationSetupStateSchema.safeParse(await this.session.command('dictation.setup.cancel', {}));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  /** Asks the computer to retry a failed engine download now (manual retries ignore the 24h automatic backoff). Returns the new state. */
  async retrySetup(): Promise<DictationSetupState> {
    const parsed = dictationSetupStateSchema.safeParse(await this.session.command('dictation.retry', {}));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  /** Android path: sends a compressed m4a recording; the computer decodes it with ffmpeg (ORBIT_FFMPEG). The bytes are zeroed when the call ends. */
  async transcribeCompressed(audio: Uint8Array, language?: string): Promise<DictationResult> {
    if (this.busy) { throw new NotSent('Already transcribing'); }
    if (audio.length === 0) throw new NotSent('Nothing was recorded');
    if (audio.length > MAX_COMPRESSED_BYTES) throw new NotSent('That recording is too long');
    this.busy = true;
    let id: string | undefined;
    try {
      const begun = dictationBeginSchema.safeParse(await this.session.command('dictation.begin', { format: 'm4a', ...(language ? { language } : {}) }));
      if (!begun.success) throw new InvalidDesktopReply();
      id = begun.data.dictationId;
      const step = DICTATION_CHUNK_SAMPLES * 2;
      for (let offset = 0; offset < audio.length; offset += step) {
        const part = audio.subarray(offset, Math.min(audio.length, offset + step));
        const ack = dictationChunkSchema.safeParse(await this.session.command('dictation.chunk', { dictationId: id, offset, dataBase64: toBase64(part) }));
        if (!ack.success || ack.data.nextOffset !== offset + part.length) throw new InvalidDesktopReply();
      }
      const result = dictationResultSchema.safeParse(await this.session.command('dictation.finish', { dictationId: id }, { timeoutMs: 120_000 }));
      if (!result.success) throw new InvalidDesktopReply();
      id = undefined;
      return legacyResult(result.data);
    } catch (error) {
      if (id) { try { await this.session.command('dictation.cancel', { dictationId: id }); } catch { /* the computer drops it on timeout or disconnect */ } }
      throw error;
    } finally { audio.fill(0); this.busy = false; }
  }
}
