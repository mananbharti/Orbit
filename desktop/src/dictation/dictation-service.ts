/** Registers dictation.* commands: collects one clip per phone connection in memory, runs the local engine, returns text; depends on the pipeline; never writes audio to disk itself and wipes it on finish, cancel, timeout or disconnect. */
import { randomUUID } from 'node:crypto';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { JsonValue } from '../protocol/messages.js';
import { ProtocolError } from '../protocol/errors.js';
import { DICTATION_TTL_MS, MAX_DICTATION_SAMPLES, beginSchema, chunkSchema, refSchema } from '../protocol/dictation.js';
import { DictationError, dictate, type Transcriber } from './pipeline.js';
import type { CleanupOptions } from './cleanup.js';

interface Clip { id: string; owner: string; connection: NonNullable<CommandContext['connection']>; samples: Int16Array; length: number; language?: string;
  timer: NodeJS.Timeout; abort: AbortController; remove: () => void; busy: boolean }

export class DictationService {
  private clip?: Clip;
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, private readonly engine: Transcriber, private readonly log: ActivityLog,
    private readonly cleanup: () => CleanupOptions = () => ({}), private readonly ttlMs = DICTATION_TTL_MS) {
    const ok = (context: CommandContext): NonNullable<CommandContext['connection']> => {
      if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
      return context.connection;
    };
    this.unregister = [
      registry.register('dictation.begin', { validate: p => beginSchema.safeParse(p).success, execute: async (p, context) => {
        const connection = ok(context);
        if (this.clip) throw new ProtocolError('BUSY');
        const { language } = beginSchema.parse(p);
        const onClose = () => this.drop();
        connection.closed.addEventListener('abort', onClose, { once: true });
        const clip: Clip = { id: randomUUID(), owner: context.session.deviceId, connection, samples: new Int16Array(MAX_DICTATION_SAMPLES), length: 0,
          ...(language ? { language } : {}), timer: setTimeout(() => this.drop(), this.ttlMs), abort: new AbortController(),
          remove: () => connection.closed.removeEventListener('abort', onClose), busy: false };
        clip.timer.unref();
        this.clip = clip;
        this.log.record({ severity: 'info', eventType: 'dictation.started', outcome: 'success' });
        return { dictationId: clip.id };
      } }),
      registry.register('dictation.chunk', { validate: p => chunkSchema.safeParse(p).success, execute: async (p, context) => {
        const clip = this.owned(context, chunkSchema.parse(p).dictationId, ok(context));
        const { offset, dataBase64 } = chunkSchema.parse(p);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw new ProtocolError('INVALID_PAYLOAD');
        const bytes = Buffer.from(dataBase64, 'base64');
        if (bytes.length === 0 || bytes.length % 2 !== 0 || offset !== clip.length) throw new ProtocolError('INVALID_PAYLOAD');
        const count = bytes.length / 2;
        if (clip.length + count > MAX_DICTATION_SAMPLES) throw new ProtocolError('INVALID_PAYLOAD');
        for (let i = 0; i < count; i++) clip.samples[clip.length + i] = bytes.readInt16LE(i * 2);
        bytes.fill(0);
        clip.length += count;
        return { nextOffset: clip.length };
      } }),
      registry.register('dictation.finish', { validate: p => refSchema.safeParse(p).success, execute: async (p, context): Promise<JsonValue> => {
        const clip = this.owned(context, refSchema.parse(p).dictationId, ok(context));
        clip.busy = true;
        const pcm = clip.samples.slice(0, clip.length);
        try {
          const result = await dictate(pcm, this.engine, { ...(clip.language ? { language: clip.language } : {}), cleanup: this.cleanup(), signal: clip.abort.signal });
          this.log.record({ severity: 'info', eventType: 'dictation.finished', outcome: 'success' });
          if (result.status === 'text') return { status: 'text', text: result.text };
          return { status: 'no-speech' };
        } catch (error) {
          this.log.record({ severity: 'warn', eventType: 'dictation.finished', outcome: 'failed' });
          throw new ProtocolError(error instanceof DictationError && error.code === 'CLIP_TOO_LONG' ? 'INVALID_PAYLOAD' : 'COMMAND_FAILED');
        } finally { this.drop(clip); }
      } }),
      registry.register('dictation.cancel', { validate: p => refSchema.safeParse(p).success, execute: async (p, context) => {
        const clip = this.owned(context, refSchema.parse(p).dictationId, ok(context));
        this.drop(clip);
        return { cancelled: true };
      } }),
    ];
  }
  async stop(): Promise<void> { for (const remove of this.unregister) remove(); this.drop(); }

  private owned(context: CommandContext, id: string, connection: NonNullable<CommandContext['connection']>): Clip {
    const clip = this.clip;
    if (!clip || clip.id !== id || clip.connection !== connection || clip.owner !== context.session.deviceId) throw new ProtocolError('INVALID_PAYLOAD');
    if (clip.busy) throw new ProtocolError('BUSY');
    return clip;
  }
  private drop(clip: Clip | undefined = this.clip): void {
    if (!clip) return;
    clearTimeout(clip.timer); clip.abort.abort(); clip.remove(); clip.samples.fill(0);
    if (this.clip === clip) this.clip = undefined;
  }
}
