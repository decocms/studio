import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { resolveSectionPreviewBase } from "./section-preview-url";

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
  sandboxUrl: string | null | undefined;
}): string | null {
  const { previewServerUrl, runtime } = useSessionRuntime(input.virtualMcpId);
  const active = runtime === "cms";
  return resolveSectionPreviewBase({
    sandboxUrl: input.sandboxUrl,
    previewServerUrl,
    fastPreviewActive: active,
  });
}
