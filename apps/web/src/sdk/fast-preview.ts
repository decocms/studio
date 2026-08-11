import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";

/**
 * The Fast Preview gate, in ONE place.
 *
 * Fast Preview is on when the CMS switch (`metadata.fastPreview`) is set AND a
 * valid preview server URL is persisted (`metadata.previewServerUrl`, or the
 * legacy `productionUrl` key) — a bare flag with no URL is inert (there is
 * nothing to render against). Pure so it serves every source of the vmcp
 * metadata (the `useVirtualMCP` query, the ambient inset entity) without a
 * hook, and so the gate can't drift across the surfaces that read it.
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
): { previewServerUrl: string | null; active: boolean } {
  const previewServerUrl = resolvePreviewServerUrl(metadata);
  return {
    previewServerUrl,
    active: !!previewServerUrl && metadata?.fastPreview === true,
  };
}
