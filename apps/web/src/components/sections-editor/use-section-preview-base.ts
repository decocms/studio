import { useVirtualMCP } from "@/sdk";
import { resolveCmsMode } from "@/sdk/cms-mode";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { resolveSectionPreviewBase } from "./section-preview-url";

/**
 * Effective base origin for the Add Section gallery previews.
 *
 * Sandbox-less branch → the preview server; otherwise the sandbox dev server
 * (see `resolveSectionPreviewBase`). Gated per branch, not per project: once a
 * branch has a pod its thumbnails must come from that pod's dev server, or the
 * gallery would preview the deployed site while the editor edits the sandbox.
 *
 * Returns `null` when neither base is available, so callers withhold the
 * gallery instead of rendering broken thumbnails.
 */
export function useSectionPreviewBase(input: {
  virtualMcpId: string;
  sandboxUrl: string | null | undefined;
}): string | null {
  const vmcp = useVirtualMCP(input.virtualMcpId);
  const { previewServerUrl } = resolveCmsMode(vmcp?.metadata);
  const { cmsModeActive } = useSandboxLifecycle();
  return resolveSectionPreviewBase({
    sandboxUrl: input.sandboxUrl,
    previewServerUrl,
    cmsModeActive,
  });
}
