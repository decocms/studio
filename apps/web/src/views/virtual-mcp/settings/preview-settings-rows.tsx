import type { Control, FieldValues } from "react-hook-form";
import { SettingsCardRow } from "@/components/settings/settings-section";
import { FastPreviewField } from "@/components/sandbox/runtime-card/fast-preview-field";
import { InPlaceRenderField } from "@/components/sandbox/runtime-card/in-place-render-field";
import { PreviewServerUrlField } from "@/components/sandbox/runtime-card/preview-server-url-field";

/**
 * The Preview card's rows: the preview server URL, then the Fast Preview
 * switch it gates and, with Fast Preview on, in-place render.
 *
 * A Blocks v8 site is always Fast Preview (`fastPreviewCapability`), so it
 * gets neither switch: only the URL. v7 keeps all three, as on main.
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
  return (
    <>
      <SettingsCardRow>
        <PreviewServerUrlField control={control} />
      </SettingsCardRow>
      {!isBlocksV8 && (
        <SettingsCardRow>
          <FastPreviewField
            control={control}
            previewServerUrl={previewServerUrl}
          />
        </SettingsCardRow>
      )}
      {!isBlocksV8 && fastPreview && (
        <SettingsCardRow>
          <InPlaceRenderField control={control} fastPreview={fastPreview} />
        </SettingsCardRow>
      )}
    </>
  );
}
