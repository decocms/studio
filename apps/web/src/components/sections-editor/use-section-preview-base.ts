import { useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { useActiveThreadMeta } from "@/hooks/use-active-thread-meta";
import { resolveSectionPreviewBase } from "./section-preview-url";

/**
 * Effective base origin for the Add Section gallery previews.
 *
 * Fast Preview ON → always the preview server; OFF → the sandbox dev server
 * (see `resolveSectionPreviewBase`). Fast Preview is gated the same way
 * everywhere (`resolveFastPreview`): the switch is on AND a preview server
 * URL is set.
 *
 * Returns `null` when neither base is available, so callers withhold the
 * gallery instead of rendering broken thumbnails.
 */
export function useSectionPreviewBase(input: {
  virtualMcpId: string;
  sandboxUrl: string | null | undefined;
}): string | null {
  const vmcp = useVirtualMCP(input.virtualMcpId);
  const { previewServerUrl, active } = resolveFastPreview(
    vmcp?.metadata,
    useActiveThreadMeta(),
  );
  return resolveSectionPreviewBase({
    sandboxUrl: input.sandboxUrl,
    previewServerUrl,
    fastPreviewActive: active,
  });
}
