import { buildDraftPointer, withDraftPointer } from "./section-preview-url";
import { useDecofileDraft } from "./decofile-api";
import { useProtocolDraft } from "./content-protocol-api";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";
import { useSessionRuntime } from "@/hooks/use-session-runtime";

interface DraftParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * This session's `?__draft=` pointer, or `null` when Fast Preview is off or no
 * pointer is ready yet: a v7 site's decofile read/write stashes a grant
 * (KEYS.decofileDraft); a content-protocol site on GitHub waits for its saved
 * commit's draft overlay ({@link useProtocolDraft}).
 *
 * The Fast Preview gate is load-bearing: a coding session shares the CMS
 * draft's branch, and the grant cache never expires, so without it a
 * `runtime: "sandbox"` thread would stamp the CMS thread's grant onto
 * dev-server links.
 *
 * Pair with {@link withDraftPointer} when building your own page path; use
 * {@link useFastPreviewDraftUrl} for one known path.
 */
export function useDraftPointer(params: DraftParams | null): string | null {
  return useDraftPointerState(params).pointer;
}

/** {@link useDraftPointer}, plus whether a newer saved commit's preview is still preparing or failed. */
function useDraftPointerState(params: DraftParams | null): {
  pointer: string | null;
  preparing: boolean;
  failed: string | null;
} {
  const fastPreviewActive =
    useSessionRuntime(params?.virtualMcpId).runtime === "cms";
  const backend = useContentBackend(params?.virtualMcpId, params?.branch);
  const github = backend.kind === "protocol" && backend.source === "github";
  const legacyDraft = useDecofileDraft(params);
  const protocolDraft = useProtocolDraft(
    github ? params : null,
    useDecofileCacheKey(params),
  );
  if (!params || !fastPreviewActive) {
    return { pointer: null, preparing: false, failed: null };
  }
  if (github) return protocolDraft;
  return {
    pointer: legacyDraft
      ? buildDraftPointer({ ...params, ...legacyDraft })
      : null,
    preparing: false,
    failed: null,
  };
}

export interface FastPreviewDraftUrl {
  /**
   * The site's own page URL carrying the `?__draft=` pointer — what the
   * preview iframe renders and what "Open in new tab" hands out. Null until a
   * decofile read/write has stashed the draft grant (KEYS.decofileDraft).
   */
  url: string | null;
  /**
   * Host of the destination the draft renders against. Derived from
   * `previewServerUrl` alone so surfaces can show "Publish to <host>" before
   * the draft grant exists. Null when the URL is absent or unparsable.
   */
  host: string | null;
  /** A newer saved commit's preview is still preparing; `url` is the previous one. */
  preparing: boolean;
  /**
   * Why the last saved commit's preview can't be shown (its overlay failed to
   * prepare), or null. `url` is then the last ready draft, or null: never the
   * published site in its place.
   */
  failed: string | null;
}

/**
 * The ONE source of Fast Preview links. The preview iframe, its "Open in new
 * tab" button, and the publish surfaces (Preview button, "Publish to <host>"
 * header) must all agree on the URL — a bare `previewServerUrl` renders the
 * LIVE site without the user's unpublished draft, which is exactly the bug
 * this hook exists to prevent.
 *
 * Pass `null` to disable (Fast Preview off / no branch): the hook still runs
 * (hooks can't be conditional) but returns nulls.
 */
export function useFastPreviewDraftUrl(
  params: {
    orgSlug: string;
    virtualMcpId: string;
    branch: string;
    previewServerUrl: string | null;
    /** Path to render, with any `:param` values already filled in. */
    path: string;
  } | null,
): FastPreviewDraftUrl {
  const {
    pointer: draftPointer,
    preparing,
    failed,
  } = useDraftPointerState(
    params
      ? {
          orgSlug: params.orgSlug,
          virtualMcpId: params.virtualMcpId,
          branch: params.branch,
        }
      : null,
  );

  const previewServerUrl = params?.previewServerUrl ?? null;
  let host: string | null = null;
  if (previewServerUrl) {
    try {
      host = new URL(previewServerUrl).host;
    } catch {
      host = null;
    }
  }

  const url =
    params && previewServerUrl && draftPointer
      ? withDraftPointer(
          new URL(params.path, previewServerUrl).toString(),
          draftPointer,
        )
      : null;

  return { url, host, preparing, failed };
}
