import { buildDraftPointer, withDraftPointer } from "./section-preview-url";
import { useDecofileDraft } from "./decofile-api";
import { useFastPreview } from "@/hooks/use-fast-preview";

interface DraftParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * This session's `?__draft=` pointer, or `null` when Fast Preview is off or no
 * decofile read/write has stashed a grant yet (KEYS.decofileDraft).
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
  const fastPreviewActive = useFastPreview(params?.virtualMcpId).active;
  const draft = useDecofileDraft(params);
  return params && draft && fastPreviewActive
    ? buildDraftPointer({ ...params, ...draft })
    : null;
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
  const draftPointer = useDraftPointer(
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

  return { url, host };
}
