/**
 * Detect credit/payment errors.
 * The backend prefixes these with `[CREDITS]` so detection is deterministic.
 *
 * Extracted as a pure .ts module so it can be imported by bun:test code
 * without dragging in @deco/ui transitively.
 */
export function isCreditError(error: Error | null): boolean {
  if (!error) return false;
  return error.message.startsWith("[CREDITS]");
}
