import { buildFastPreviewDraftUrl } from "./section-preview-url";
import { useDecofileDraft } from "./decofile-api";

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
  const draft = useDecofileDraft(
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
    params && previewServerUrl && draft
      ? buildFastPreviewDraftUrl({
          previewServerUrl,
          apiHost: draft.apiHost,
          orgSlug: params.orgSlug,
          virtualMcpId: params.virtualMcpId,
          branch: params.branch,
          token: draft.token,
          version: draft.version,
          path: params.path,
        })
      : null;

  return { url, host };
}
