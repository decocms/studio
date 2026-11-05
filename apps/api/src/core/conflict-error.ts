/**
 * A refusal the caller can fix: the request is valid, but the resource's
 * current state does not allow it. The message says what to do instead.
 * The REST tool route answers 409; the MCP path returns it as a tool error.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
