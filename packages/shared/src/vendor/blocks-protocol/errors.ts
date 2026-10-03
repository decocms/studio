/**
 * Content-protocol errors. Every failure travels as a JSON-RPC 2.0 `error`
 * object (HTTP 200), except a missing or invalid bearer token (401) and a body
 * over the size limit (413), which apply to the whole batch.
 */

export const ErrorCode = {
  // Standard JSON-RPC 2.0 codes.
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Content-protocol codes.
  NotFound: -32001,
  Conflict: -32002,
  InvalidBlock: -32003,
  ReadOnly: -32005,
  Unsupported: -32006,
  LimitExceeded: -32007,
  Unavailable: -32008,
  Unauthorized: -32010,
  Forbidden: -32011,
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

/** The JSON-RPC `error` object. */
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** One entry's failed `ifMatch` guard. */
export interface VersionMismatch {
  expected: string | null;
  actual: string | null;
}

/** `error.data` of a Conflict (-32002). */
export interface ConflictData {
  entries?: Record<string, VersionMismatch>;
  schema?: { expected: string; actual: string | null };
}

/** One rule a `blocks.apply` breaks. */
export interface BlockViolation {
  /** The entry name the violation is about. */
  name: string;
  /** A JSON Pointer inside the entry, when the violation is about one value. */
  pointer?: string;
  rule: string;
  message: string;
}

/** `error.data` of an InvalidBlock (-32003). */
export interface InvalidBlockData {
  violations: BlockViolation[];
}

/** `error.data` of an Unavailable (-32008). */
export interface UnavailableData {
  retryAfterMs?: number;
}

/**
 * An error a method fails with. The server turns it into the JSON-RPC
 * `error` object; the client throws it back.
 */
export class ContentProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ContentProtocolError";
    this.code = code;
    this.data = data;
  }

  toJSON(): RpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  static from(error: RpcErrorObject): ContentProtocolError {
    return new ContentProtocolError(error.code, error.message, error.data);
  }
}

export const notFound = (message: string) =>
  new ContentProtocolError(ErrorCode.NotFound, message);

export const conflict = (data: ConflictData) =>
  new ContentProtocolError(ErrorCode.Conflict, "a precondition failed", data);

export const invalidBlock = (violations: BlockViolation[]) =>
  new ContentProtocolError(
    ErrorCode.InvalidBlock,
    violations.length === 1
      ? `invalid block "${violations[0]!.name}": ${violations[0]!.message}`
      : `${violations.length} invalid blocks`,
    { violations } satisfies InvalidBlockData,
  );

export const readOnly = () =>
  new ContentProtocolError(ErrorCode.ReadOnly, "this endpoint is read-only");

export const unsupported = (message: string) =>
  new ContentProtocolError(ErrorCode.Unsupported, message);

export const limitExceeded = (
  message: string,
  data?: Record<string, unknown>,
) => new ContentProtocolError(ErrorCode.LimitExceeded, message, data);

export const unavailable = (message: string, retryAfterMs?: number) =>
  new ContentProtocolError(
    ErrorCode.Unavailable,
    message,
    retryAfterMs === undefined
      ? undefined
      : ({ retryAfterMs } satisfies UnavailableData),
  );

export const invalidParams = (message: string, data?: unknown) =>
  new ContentProtocolError(ErrorCode.InvalidParams, message, data);

export const invalidRequest = (message: string) =>
  new ContentProtocolError(ErrorCode.InvalidRequest, message);

export const methodNotFound = (method: string) =>
  new ContentProtocolError(
    ErrorCode.MethodNotFound,
    `unknown method "${method}"`,
  );

export const parseError = () =>
  new ContentProtocolError(ErrorCode.ParseError, "invalid JSON");

export const internalError = () =>
  new ContentProtocolError(ErrorCode.InternalError, "internal error");

export const unauthorized = () =>
  new ContentProtocolError(
    ErrorCode.Unauthorized,
    "missing or invalid bearer token",
  );

export const forbidden = () =>
  new ContentProtocolError(ErrorCode.Forbidden, "not allowed for this project");
