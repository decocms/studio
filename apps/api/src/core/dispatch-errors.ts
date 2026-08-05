export type PermanentRunErrorCode =
  | "empty_request"
  | "agent_not_found"
  | "model_not_allowed";

export class PermanentRunError extends Error {
  /** Own-enumerable so it survives DBOS error (de)serialization. */
  readonly permanent = true as const;
  readonly code: PermanentRunErrorCode;

  constructor(code: PermanentRunErrorCode, message: string) {
    super(message);
    this.name = "PermanentRunError";
    this.code = code;
  }
}

export function isPermanentRunError(err: unknown): boolean {
  return (
    err instanceof PermanentRunError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { permanent?: unknown }).permanent === true)
  );
}
