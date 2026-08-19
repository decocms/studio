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

/**
 * Whether creating a brand-new branch should start a fresh CMS thread instead
 * of reusing the current session. True only when the project supports Fast
 * Preview but the active thread is a sandbox coding session: the runtime stamp
 * is per-thread and immutable, so the only way a new branch lands in CMS is a
 * new (unstamped) thread. When already in CMS — or without the capability — the
 * in-place branch switch already yields the right runtime.
 */
export function shouldStartBranchAsCms(
  metadata: Parameters<typeof resolveFastPreview>[0],
  threadMetadata?: Parameters<typeof resolveFastPreview>[1],
): boolean {
  const projectSupportsCms = resolveFastPreview(metadata).active;
  const sessionIsCms = resolveFastPreview(metadata, threadMetadata).active;
  return projectSupportsCms && !sessionIsCms;
}
