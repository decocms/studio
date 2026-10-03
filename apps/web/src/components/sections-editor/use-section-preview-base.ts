import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { resolveSectionPreviewBase } from "./section-preview-url";
import { useContentBackend } from "./use-content-backend";
import { contentCapabilities } from "./content-backend";

/**
 * Effective base origin for the Add Section gallery previews.
 *
 * Fast Preview ON → always the preview server; OFF → the sandbox dev server
 * (see `resolveSectionPreviewBase`). The gate itself comes from
 * {@link useSessionRuntime}, so this can't drift from the other CMS surfaces.
 *
 * Returns `null` when neither base is available, so callers withhold the
 * gallery instead of rendering broken thumbnails.
 */
export function useSectionPreviewBase(input: {
  virtualMcpId: string;
  branch: string;
  sandboxUrl: string | null | undefined;
}): string | null {
  const { previewServerUrl, runtime } = useSessionRuntime(input.virtualMcpId);
  const { url: localPreviewUrl } = useLocalPreviewUrl(input.virtualMcpId);
  const backend = useContentBackend(input.virtualMcpId, input.branch);
  const active = runtime === "cms";
  // The content protocol never runs site code, so nothing renders a preview.
  if (!contentCapabilities(backend).livePreviews) return null;
  // Local tunnel is a live deco dev server: render the gallery against it.
  if (localPreviewUrl) return localPreviewUrl;
  return resolveSectionPreviewBase({
    sandboxUrl: input.sandboxUrl,
    previewServerUrl,
    fastPreviewActive: active,
  });
}
