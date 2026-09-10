import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { useT } from "@/i18n/use-t.ts";

/**
 * The experimental in-place-render switch (`metadata.fastPreviewInPlace`).
 * Layered on Fast Preview: it only changes HOW edits refresh (an in-place
 * /live/previews render vs. a commit + re-navigation), so it's inert — and
 * hidden — unless Fast Preview is on. `fastPreview` is passed by the parent from
 * `form.watch("metadata.fastPreview")` so the switch reacts to that toggle
 * without this leaf owning the form type. Mirrors `FastPreviewField`.
 */
export interface InPlaceRenderFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Current `metadata.fastPreview` value (watched by the parent). */
  fastPreview: boolean | null | undefined;
}

export function InPlaceRenderField<T extends FieldValues>({
  control,
  fastPreview,
}: InPlaceRenderFieldProps<T>) {
  const t = useT();
  if (!fastPreview) return null;
  return (
    <Controller
      control={control}
      name={"metadata.fastPreviewInPlace" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="fast-preview-in-place"
              className="font-normal text-foreground"
            >
              {t("sandbox.cmsSettings.fastPreviewInPlace.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.cmsSettings.fastPreviewInPlace.description")}
            </p>
          </div>
          <Switch
            id="fast-preview-in-place"
            className="shrink-0"
            checked={!!field.value}
            onCheckedChange={(checked) => field.onChange(checked)}
          />
        </div>
      )}
    />
  );
}
