/** Defines one native input session's lifecycle; depends on AbortSignal; does not authenticate commands or define input events. */
export interface InputSessionAdapter {
  /** Constructors must not acquire native resources. Open only after verification; abort must prevent further input. */
  open(signal: AbortSignal): Promise<void>;
  /** Release only inputs held by this adapter, including partially applied batches. Must be idempotent. */
  releaseAll(): Promise<void>;
  /** Close native resources after release, including when open failed partway through. */
  dispose(): Promise<void>;
}
