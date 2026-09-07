/** Defines safe wire errors; depends on no modules; never exposes underlying exceptions. */
export type ErrorCode =
  | 'INVALID_MESSAGE' | 'UNSUPPORTED_VERSION' | 'UNAUTHENTICATED'
  | 'UNKNOWN_COMMAND' | 'INVALID_PAYLOAD' | 'BIOMETRIC_REQUIRED'
  | 'COMMAND_FAILED' | 'DUPLICATE_REQUEST' | 'BUSY'
  | 'CLIPBOARD_UNAVAILABLE' | 'CLIPBOARD_NOT_SUBSCRIBED'
  | 'FILE_NOT_FOUND' | 'FILE_INVALID_STATE' | 'FILE_INVALID_LEASE' | 'FILE_QUOTA'
  | 'FILE_OFFSET' | 'FILE_INTEGRITY' | 'FILE_SOURCE_CHANGED' | 'FILE_IO' | 'FILE_EXPIRED';

export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}
