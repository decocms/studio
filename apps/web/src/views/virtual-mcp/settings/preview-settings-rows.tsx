import type { Control, FieldValues } from "react-hook-form";
import { SettingsCardRow } from "@/components/settings/settings-section";
import { FastPreviewField } from "@/components/sandbox/runtime-card/fast-preview-field";
import { InPlaceRenderField } from "@/components/sandbox/runtime-card/in-place-render-field";
import { PreviewServerUrlField } from "@/components/sandbox/runtime-card/preview-server-url-field";
import { sanitizeSiteUrl } from "@decocms/shared/deco-site-production-url";
import { useT } from "@/i18n/use-t.ts";

/**
 * The Preview card's rows: the preview server URL, then the Fast Preview
 * switch it gates and, with Fast Preview on, in-place render.
 *
 * A Blocks v8 site is always Fast Preview (`fastPreviewCapability`), so it
 * gets no Fast Preview switch: in its place, a hint while there is no URL
 * (without one, new chats start a coding session), and in-place render is
 * always offered. v7 keeps all three, as on main.
 */
export function PreviewSettingsRows<T extends FieldValues>({
  control,
  isBlocksV8,
  previewServerUrl,
  fastPreview,
}: {
  control: Control<T>;
  isBlocksV8: boolean;
  /** Watched `metadata.previewServerUrl`. */
  previewServerUrl: string | null | undefined;
  /** Watched `metadata.fastPreview`. */
  fastPreview: boolean | null | undefined;
}) {
  const t = useT();
  const fastPreviewOn = isBlocksV8 || !!fastPreview;
  return (
    <>
      <SettingsCardRow>
        <PreviewServerUrlField control={control} isBlocksV8={isBlocksV8} />
      </SettingsCardRow>
      {isBlocksV8 ? (
        !sanitizeSiteUrl(previewServerUrl) && (
          <SettingsCardRow>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.cmsSettings.blocksV8.needsPreviewServerUrl")}
            </p>
          </SettingsCardRow>
        )
      ) : (
        <SettingsCardRow>
          <FastPreviewField
            control={control}
            previewServerUrl={previewServerUrl}
          />
        </SettingsCardRow>
      )}
      {fastPreviewOn && (
        <SettingsCardRow>
          <InPlaceRenderField control={control} fastPreview={fastPreviewOn} />
        </SettingsCardRow>
      )}
    </>
  );
}
