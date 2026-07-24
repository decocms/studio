/**
 * Detect "paid seat required" errors.
 * The backend prefixes these with `[PAID_SEAT_REQUIRED]` so detection is
 * deterministic — same convention as `[CREDITS]` in
 * ../chat/is-credit-error.ts.
 *
 * Extracted as a pure .ts module so it can be imported by bun:test code
 * without dragging in @deco/ui transitively.
 */
export function isPaidSeatError(error: Error | null | undefined): boolean {
  if (!error) return false;
  return error.message.startsWith("[PAID_SEAT_REQUIRED]");
}
