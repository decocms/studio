import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { useT } from "@/i18n/use-t.ts";

// Generic over the parent form schema, same pattern as FieldDescriptionTooltipsField.
export interface DefaultsOnCreateOnlyFieldProps<T extends FieldValues> {
  control: Control<T>;
}

/** `metadata.defaultsOnCreateOnly`: off unless explicitly `true`. */
export function DefaultsOnCreateOnlyField<T extends FieldValues>({
  control,
}: DefaultsOnCreateOnlyFieldProps<T>) {
  const t = useT();
  return (
    <Controller
      control={control}
      name={"metadata.defaultsOnCreateOnly" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="defaults-on-create-only"
              className="font-normal text-foreground"
            >
              {t("sandbox.defaultsOnCreateOnlyField.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.defaultsOnCreateOnlyField.description")}
            </p>
          </div>
          <Switch
            id="defaults-on-create-only"
            className="shrink-0"
            checked={(field.value as boolean | null | undefined) === true}
            onCheckedChange={(next) => field.onChange(next)}
          />
        </div>
      )}
    />
  );
}
