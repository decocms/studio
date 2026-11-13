const REQUEST_TIMEOUT_MS = 60_000;

/** A stalled request must settle so failed reads can release their shared load and retry. */
export function cmsRequestSignal(
  signal?: AbortSignal | null,
  timeoutMs = REQUEST_TIMEOUT_MS,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
