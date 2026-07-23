import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { useT } from "@/web/i18n/use-t.ts";
import { productionUrlFromDomain } from "@/shared/deco-site-production-url";

// Generic over the parent form schema so callers pass `form.control` without
// casting — mirrors RuntimeFields. Bound to `metadata.productionUrl`; the field
// path is a literal contract asserted via `FieldPath<T>`, kept to this leaf.
export interface ProductionUrlFieldProps<T extends FieldValues> {
  control: Control<T>;
}

export function ProductionUrlField<T extends FieldValues>({
  control,
}: ProductionUrlFieldProps<T>) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label htmlFor="production-url">
        {t("sandbox.productionUrlField.label")}
      </Label>
      <Controller
        control={control}
        name={"metadata.productionUrl" as FieldPath<T>}
        render={({ field }) => {
          const value = (field.value as string | null | undefined) ?? "";
          return (
            <Input
              id="production-url"
              type="url"
              inputMode="url"
              placeholder={t("sandbox.productionUrlField.placeholder")}
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
        {t("sandbox.productionUrlField.description")}
      </p>
    </div>
  );
}
