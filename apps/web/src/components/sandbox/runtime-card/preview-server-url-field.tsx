import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { useT } from "@/i18n/use-t.ts";
import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";

// NOTE: manual entry is a stopgap. Ideally `metadata.previewServerUrl` is not
// set by hand — it's auto-populated at deco.cx import from the site's
// production domain, and once we ship the domain-setup capability it should be
// sourced from the site's `domains` array (the domain flagged `production`)
// instead of this free-text field.
//
// Generic over the parent form schema so callers pass `form.control` without
// casting — mirrors RuntimeFields. Bound to `metadata.previewServerUrl` (the
// parent seeds it from the legacy `productionUrl` key via
// resolvePreviewServerUrl, so saving migrates the value forward); the field
// path is a literal contract asserted via `FieldPath<T>`, kept to this leaf.
export interface PreviewServerUrlFieldProps<T extends FieldValues> {
  control: Control<T>;
}

export function PreviewServerUrlField<T extends FieldValues>({
  control,
}: PreviewServerUrlFieldProps<T>) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label htmlFor="preview-server-url">
        {t("sandbox.previewServerUrlField.label")}
      </Label>
      <Controller
        control={control}
        name={"metadata.previewServerUrl" as FieldPath<T>}
        render={({ field }) => {
          const value = (field.value as string | null | undefined) ?? "";
          return (
            <Input
              id="preview-server-url"
              type="url"
              inputMode="url"
              placeholder={t("sandbox.previewServerUrlField.placeholder")}
              value={value}
              // Keep raw while typing (empty → null); the preview sanitizes on
              // read, so an in-progress value can't break anything.
              onChange={(e) =>
                field.onChange(e.target.value === "" ? null : e.target.value)
              }
              // Normalize on blur: bare host → https URL, invalid/empty → null.
              onBlur={() => {
                field.onChange(productionUrlFromDomain(value));
                field.onBlur();
              }}
            />
          );
        }}
      />
      <p className="text-xs text-muted-foreground">
        {t("sandbox.previewServerUrlField.description")}
      </p>
    </div>
  );
}
