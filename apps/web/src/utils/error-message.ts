/** Extract a user-facing message from a caught error, falling back when the
 *  error isn't an `Error` or carries no (or a blank) message. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
