/** First-run dictation engine provisioning: downloads one pinned whisper.cpp build and one pinned ggml model per computer, verifies sha256 before use, extracts with the system tar, and stores both under the private data directory. Downloads binaries only; audio never leaves the device. Env overrides (ORBIT_WHISPER_BIN / ORBIT_WHISPER_MODEL) always win and skip every download. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

export interface EnginePaths { binary: string; model: string }
export type ProvisionErrorCode = 'UNSUPPORTED_PLATFORM' | 'DOWNLOAD_FAILED' | 'HASH_MISMATCH' | 'EXTRACT_FAILED';
export class ProvisionError extends Error {
  constructor(readonly code: ProvisionErrorCode, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = 'ProvisionError'; }
}

export interface Asset { url: string; sha256: string; file: string }
interface PlatformBuild extends Asset { binaryRel: string }
export interface AssetTable { model: Asset; builds: Record<string, PlatformBuild> }

/** Pinned at b5454 (2026-10) + ggml-tiny from the official whisper.cpp model bucket; whisper.cpp and the Whisper models are MIT licensed. Hashes verified out-of-band on 2026-10-24. */
export const PINNED_ASSETS: AssetTable = {
  model: { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', file: 'ggml-tiny.bin' },
  builds: {
    'win32-x64': { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb', file: 'engine.zip', binaryRel: join('Release', 'whisper-cli.exe') },
    'linux-x64': { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz', sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c', file: 'engine.tar.gz', binaryRel: 'whisper-cli' },
  },
};

const run = promisify(execFile);

async function sha256Of(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', d => hash.update(d)).on('end', () => resolveHash(hash.digest('hex'))).on('error', reject);
  });
}

async function defaultFetch(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new ProvisionError('DOWNLOAD_FAILED', `${url} -> HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
}

async function defaultExtract(archive: string, destDir: string): Promise<void> {
  // bsdtar ships as tar.exe on Windows 10+ and reads zip as well as tar.gz; no bundled extractor needed.
  try { await run('tar', ['-xf', archive, '-C', destDir], { windowsHide: true, timeout: 120_000 }); }
  catch (e) { throw new ProvisionError('EXTRACT_FAILED', e instanceof Error ? e.message : String(e)); }
}

export interface ProvisionOptions {
  platform?: string; arch?: string; env?: NodeJS.ProcessEnv; dataDir: string;
  assets?: AssetTable; fetchImpl?: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  extractImpl?: (archive: string, destDir: string) => Promise<void>;
  onStage?: (stage: 'engine' | 'model' | 'verify' | 'done') => void;
  signal?: AbortSignal;
}

/** Env pair first, then an already-provisioned pair, else null. Never throws. */
export function resolveEnginePaths(env: NodeJS.ProcessEnv, dataDir: string, assets: AssetTable = PINNED_ASSETS, platform: string = process.platform, arch: string = process.arch): EnginePaths | undefined {
  const bin = env.ORBIT_WHISPER_BIN; const model = env.ORBIT_WHISPER_MODEL;
  if (bin && model && existsSync(bin) && existsSync(model)) return { binary: bin, model };
  const build = assets.builds[`${platform}-${arch}`];
  if (build) {
    const dir = join(dataDir, 'dictation');
    const binary = join(dir, 'engine', build.binaryRel); const provisionedModel = join(dir, assets.model.file);
    if (existsSync(binary) && existsSync(provisionedModel)) return { binary, model: provisionedModel };
  }
  return undefined;
}

/** Resolves an existing engine or downloads and verifies one. Returns the paths; throws ProvisionError on any failure - callers keep dictation off and report honestly. */
export async function ensureEngine(options: ProvisionOptions): Promise<EnginePaths> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform; const arch = options.arch ?? process.arch;
  const assets = options.assets ?? PINNED_ASSETS;
  const existing = resolveEnginePaths(env, options.dataDir, assets, platform, arch);
  if (existing) return existing;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const signal = options.signal;
  const cancelled = () => { if (signal?.aborted) throw new ProvisionError('DOWNLOAD_FAILED', 'cancelled'); };
  const extractImpl = options.extractImpl ?? defaultExtract;
  const build = assets.builds[`${platform}-${arch}`];
  if (!build) throw new ProvisionError('UNSUPPORTED_PLATFORM', `${platform}-${arch}: install whisper.cpp yourself and set ORBIT_WHISPER_BIN/ORBIT_WHISPER_MODEL`);

  const dir = join(options.dataDir, 'dictation');
  const work = mkdtempSync(join(tmpdir(), 'orbit-engine-'));
  try {
    options.onStage?.('engine');
    cancelled();
    const engineArchive = join(work, build.file);
    await fetchImpl(build.url, engineArchive, signal).catch(e => { throw e instanceof ProvisionError ? e : new ProvisionError('DOWNLOAD_FAILED', e instanceof Error ? e.message : String(e)); });
    options.onStage?.('verify');
    if ((await sha256Of(engineArchive)) !== build.sha256) throw new ProvisionError('HASH_MISMATCH', build.file);
    const engineOut = join(work, 'engine');
    mkdirSync(engineOut, { recursive: true });
    await extractImpl(engineArchive, engineOut);
    // Archives nest their payload (Release/... or whisper-bin-ubuntu-x64/...); normalize to one engine dir.
    const nested = join(engineOut, 'whisper-bin-ubuntu-x64');
    const normalized = join(work, 'engine-final');
    if (existsSync(join(engineOut, build.binaryRel))) renameSync(engineOut, normalized);
    else if (existsSync(join(nested, build.binaryRel))) renameSync(nested, normalized);
    else throw new ProvisionError('EXTRACT_FAILED', `whisper-cli missing after extracting ${build.file}`);

    options.onStage?.('model');
    cancelled();
    const modelPath = join(work, assets.model.file);
    await fetchImpl(assets.model.url, modelPath, signal).catch(e => { throw e instanceof ProvisionError ? e : new ProvisionError('DOWNLOAD_FAILED', e instanceof Error ? e.message : String(e)); });
    if ((await sha256Of(modelPath)) !== assets.model.sha256) throw new ProvisionError('HASH_MISMATCH', assets.model.file);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    renameSync(normalized, join(dir, 'engine'));
    renameSync(modelPath, join(dir, assets.model.file));
    const binary = join(dir, 'engine', build.binaryRel);
    if (platform !== 'win32') chmodSync(binary, 0o700);
    options.onStage?.('done');
    return { binary, model: join(dir, assets.model.file) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Provisioning state, honesty and backoff --------------------------------

const ATTEMPT_FILE = 'dictation-last-attempt';
export const AUTO_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** True when an automatic (startup) provision attempt is allowed: never attempted, or the last attempt is older than the backoff window. User-triggered retries ignore this. */
export function autoProvisionAllowed(dataDir: string, now: number = Date.now()): boolean {
  try {
    const stamp = Number(readFileSync(join(dataDir, 'dictation', ATTEMPT_FILE), 'utf8'));
    return !Number.isFinite(stamp) || now - stamp >= AUTO_RETRY_AFTER_MS;
  } catch { return true; }
}

export function markProvisionAttempt(dataDir: string, now: number = Date.now()): void {
  const dir = join(dataDir, 'dictation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ATTEMPT_FILE), String(now), { mode: 0o600 });
}

export type DictationSetupState = { state: 'off' | 'downloading' | 'ready' | 'failed'; reason?: string };

import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { ActivityLog } from '../activity-log/activity-log.js';
import { ProtocolError } from '../protocol/errors.js';

/** Owns dictation engine availability as a visible, retryable, cancellable state machine; registers dictation.status/retry so a phone always gets an honest answer, including while the one-time download runs. Depends on the registry and ensureEngine; never retries in a loop by itself. */
export class DictationSetup {
  private current: DictationSetupState = { state: 'off' };
  private abort?: AbortController;
  private running?: Promise<void>;

  constructor(registry: CommandRegistry, private readonly dataDir: string,
    private readonly onReady: (paths: EnginePaths) => void, private readonly log: ActivityLog,
    private readonly options: { env?: NodeJS.ProcessEnv; provision?: (o: ProvisionOptions) => Promise<EnginePaths>; auto?: boolean } = {}) {
    const ok = (context: CommandContext): void => { if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED'); };
    registry.register('dictation.status', { validate: p => p === undefined || (typeof p === 'object' && p !== null && Object.keys(p).length === 0),
      execute: async (_p, context) => { ok(context); return this.statusPayload(); } });
    registry.register('dictation.retry', { validate: p => p === undefined || (typeof p === 'object' && p !== null && Object.keys(p).length === 0),
      execute: async (_p, context) => { ok(context); void this.start(true); return this.statusPayload(); } });
    registry.register('dictation.setup.cancel', { validate: p => p === undefined || (typeof p === 'object' && p !== null && Object.keys(p).length === 0),
      execute: async (_p, context) => { ok(context); this.cancel(); return this.statusPayload(); } });
  }

  private statusPayload(): Record<string, string> {
    return this.current.reason ? { state: this.current.state, reason: this.current.reason } : { state: this.current.state };
  }

  get state(): DictationSetupState { return this.current; }

  /** Marks the engine ready when it was configured outside provisioning (env override wired at startup). */
  markReady(): void { this.current = { state: 'ready' }; }

  /** Startup path: attach an existing engine immediately, or kick off one automatic attempt when backoff allows. */
  autoStart(): EnginePaths | undefined {
    const existing = resolveEnginePaths(this.options.env ?? process.env, this.dataDir);
    if (existing) { this.current = { state: 'ready' }; return existing; }
    if ((this.options.auto ?? true) && autoProvisionAllowed(this.dataDir)) void this.start(false);
    return undefined;
  }

  /** Starts (or joins) the one-time download. `manual` retries ignore the backoff window. */
  async start(manual: boolean): Promise<void> {
    if (this.current.state === 'ready' || this.running) return this.running;
    if (!manual && !autoProvisionAllowed(this.dataDir)) return;
    markProvisionAttempt(this.dataDir);
    this.abort = new AbortController();
    this.current = { state: 'downloading' };
    const provision = this.options.provision ?? (o => ensureEngine(o));
    this.running = (async () => {
      try {
        const paths = await provision({ dataDir: this.dataDir, env: this.options.env, signal: this.abort!.signal });
        this.current = { state: 'ready' };
        this.onReady(paths);
        this.log.record({ severity: 'info', eventType: 'dictation.engine_ready', outcome: 'success' });
      } catch (e) {
        const reason = e instanceof ProvisionError ? e.code : 'DOWNLOAD_FAILED';
        this.current = { state: 'failed', reason };
        this.log.record({ severity: 'info', eventType: 'dictation.engine_unavailable', outcome: 'failed' });
      } finally { this.running = undefined; this.abort = undefined; }
    })();
    return this.running;
  }

  /** Cancels an in-flight download; the partial tree is cleaned by ensureEngine. */
  cancel(): void {
    this.abort?.abort();
    if (this.current.state === 'downloading') this.current = { state: 'failed', reason: 'cancelled' };
  }
}
