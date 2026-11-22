/**
 * Input a tool's handler rejects after its schema passed, such as arguments
 * checked against a schema only known at call time. The message says what to
 * send instead. The REST tool route answers 400, like a schema failure; the
 * MCP path returns it as a tool error.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
