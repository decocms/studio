import { resolveSessionRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * The Fast Preview gate, in ONE place — per SESSION, not just per project:
 * active iff `resolveSessionRuntime` (shared with the API's sandbox-proxy
 * claim) resolves "cms". Thread-scoped surfaces pass the active thread's
 * metadata (`useActiveThreadMeta()`) so a `runtime: "sandbox"` stamp opts the
 * session out; thread-less surfaces omit it and get the project default.
 */
export function resolveFastPreview(
  metadata:
    | {
        previewServerUrl?: string | null;
        productionUrl?: string | null;
        fastPreview?: boolean | null;
      }
    | null
    | undefined,
  threadMetadata?: { runtime?: unknown } | null,
): { previewServerUrl: string | null; active: boolean } {
  const { runtime, previewServerUrl } = resolveSessionRuntime(
    metadata,
    threadMetadata,
  );
  return { previewServerUrl, active: runtime === "cms" };
}
