/** Defines the native pointer and keyboard actions of one control session; depends on input messages; does not authorize or confirm anything. */
import type { InputSessionAdapter } from './input-session.js';
import type { InputEvent } from '../protocol/input.js';

export interface InputDevice extends InputSessionAdapter {
  /** Applies one event. Buttons pressed by this adapter must be released by releaseAll. */
  apply(event: InputEvent, signal: AbortSignal): Promise<void>;
}
