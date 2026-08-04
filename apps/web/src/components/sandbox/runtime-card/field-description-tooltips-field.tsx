import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@deco/ui/components/label.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useT } from "@/i18n/use-t.ts";

// Generic over the parent form schema, same pattern as ProductionUrlField.
export interface FieldDescriptionTooltipsFieldProps<T extends FieldValues> {
  control: Control<T>;
}

export function FieldDescriptionTooltipsField<T extends FieldValues>({
  control,
}: FieldDescriptionTooltipsFieldProps<T>) {
  const t = useT();
  return (
    <Controller
      control={control}
      name={"metadata.fieldDescriptionTooltips" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="field-description-tooltips">
              {t("sandbox.fieldDescriptionTooltipsField.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.fieldDescriptionTooltipsField.description")}
            </p>
          </div>
          <Switch
            id="field-description-tooltips"
            checked={(field.value as boolean | null | undefined) ?? false}
            onCheckedChange={(next) => field.onChange(next)}
          />
        </div>
      )}
    />
  );
}
