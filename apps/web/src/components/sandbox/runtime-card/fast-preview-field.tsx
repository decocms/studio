import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { sanitizeSiteUrl } from "@decocms/shared/deco-site-production-url";
import { useT } from "@/i18n/use-t.ts";

// The Fast Preview switch (`metadata.fastPreview`). Gated on the preview
// server URL: Fast Preview renders the draft against that URL, so with none
// set there's nothing to render against — the switch stays disabled (and
// visually off) until one is provided. `previewServerUrl` is passed by the
// parent from `form.watch("metadata.previewServerUrl")` so the switch reacts
// to edits without this leaf owning the form type. Generic over the parent
// schema, mirroring `PreviewServerUrlField`.
export interface FastPreviewFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Current `metadata.previewServerUrl` value (watched by the parent). */
  previewServerUrl: string | null | undefined;
}

export function FastPreviewField<T extends FieldValues>({
  control,
  previewServerUrl,
}: FastPreviewFieldProps<T>) {
  const t = useT();
  const hasPreviewServerUrl = !!sanitizeSiteUrl(previewServerUrl);
  return (
    <Controller
      control={control}
      name={"metadata.fastPreview" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="fast-preview"
              className="font-normal text-foreground"
            >
              {t("sandbox.cmsSettings.fastPreview.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {hasPreviewServerUrl
                ? t("sandbox.cmsSettings.fastPreview.description")
                : t("sandbox.cmsSettings.fastPreview.needsPreviewServerUrl")}
            </p>
          </div>
          <Switch
            id="fast-preview"
            className="shrink-0"
            // Reflect the stored intent, but never show "on" without a URL to
            // render against — the preview gate requires both anyway.
            checked={!!field.value && hasPreviewServerUrl}
            disabled={!hasPreviewServerUrl}
            onCheckedChange={(checked) => field.onChange(checked)}
          />
        </div>
      )}
    />
  );
}
