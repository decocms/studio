/**
 * Runtime guard for the durable outbox (spec §5.1, N5).
 *
 * The link daemon ships via `bunx decocms@latest link` and runs under the *user's*
 * runtime — unlike the spawned sandbox daemon (`bun build --target=bun`). The
 * outbox uses `bun:sqlite`, which is built-in ONLY under Bun. We require Bun
 * and fail loudly otherwise rather than crashing later with an opaque import
 * error.
 *
 * Injecting `versions` keeps this unit-testable without spawning a Node child.
 */
export function isBunRuntime(
  versions: Record<string, string | undefined> = process.versions as Record<
    string,
    string | undefined
  >,
): boolean {
  return typeof versions.bun === "string" && versions.bun.length > 0;
}

export function assertBunRuntime(
  versions?: Record<string, string | undefined>,
): void {
  if (isBunRuntime(versions)) return;
  throw new Error(
    "[outbox] the durable outbox requires the Bun runtime (bun:sqlite is " +
      "built-in only under Bun). Re-run the link daemon with `bunx decocms " +
      "link` under Bun.",
  );
}
