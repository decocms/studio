import { useVirtualMCP } from "@/sdk";
import { resolveCmsMode } from "@/sdk/cms-mode";
import { resolveSectionPreviewBase } from "./section-preview-url";

/**
 * Effective base origin for the Add Section gallery previews.
 *
 * Fast Preview ON → always the preview server; OFF → the sandbox dev server
 * (see `resolveSectionPreviewBase`). Fast Preview is gated the same way
 * everywhere (`resolveCmsMode`): the switch is on AND a preview server
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
  const { previewServerUrl, active } = resolveCmsMode(vmcp?.metadata);
  return resolveSectionPreviewBase({
    sandboxUrl: input.sandboxUrl,
    previewServerUrl,
    cmsModeActive: active,
  });
}
