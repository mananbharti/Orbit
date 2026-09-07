/** Defines safe wire errors; depends on no modules; never exposes underlying exceptions. */
export type ErrorCode =
  | 'INVALID_MESSAGE' | 'UNSUPPORTED_VERSION' | 'UNAUTHENTICATED'
  | 'UNKNOWN_COMMAND' | 'INVALID_PAYLOAD' | 'BIOMETRIC_REQUIRED'
  | 'COMMAND_FAILED' | 'DUPLICATE_REQUEST' | 'BUSY'
  | 'CLIPBOARD_UNAVAILABLE' | 'CLIPBOARD_NOT_SUBSCRIBED';

export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}
