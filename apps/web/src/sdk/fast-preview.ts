import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { readThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * The Fast Preview gate for surfaces that hold plain metadata rather than a
 * React scope. `active` is `readThreadRuntime(...) === "cms"` — the session's
 * own stamp, with the project default answering only for an unstamped thread.
 *
 * Prefer `useSessionRuntime` in components; this stays for the pure call sites
 * (and for `useFastPreview`, which wraps it).
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
  return {
    previewServerUrl: resolvePreviewServerUrl(metadata),
    active: readThreadRuntime(threadMetadata, metadata) === "cms",
  };
}
