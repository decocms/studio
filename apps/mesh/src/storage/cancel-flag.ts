/**
 * Durable cancel flag helpers (Phase C).
 *
 * `cancel_requested_at` is set by the cancel endpoint and read by the ingest
 * backstop. A non-null timestamp means the run was cancelled — the ingest
 * endpoint MUST reject with 409 regardless of the fence state.
 */
export function isCancelRequested(cancelRequestedAt: Date | null): boolean {
  return cancelRequestedAt !== null;
}
