import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { useT } from "@/i18n/use-t.ts";

// Generic over the parent form schema, same pattern as ProductionUrlField.
export interface LegacyBlogPostFormatFieldProps<T extends FieldValues> {
  control: Control<T>;
}

export function LegacyBlogPostFormatField<T extends FieldValues>({
  control,
}: LegacyBlogPostFormatFieldProps<T>) {
  const t = useT();
  return (
    <Controller
      control={control}
      name={"metadata.legacyBlogPostFormat" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="legacy-blog-post-format"
              className="font-normal text-foreground"
            >
              {t("sandbox.legacyBlogPostFormatField.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.legacyBlogPostFormatField.description")}
            </p>
          </div>
          <Switch
            id="legacy-blog-post-format"
            className="shrink-0"
            checked={(field.value as boolean | null | undefined) ?? false}
            onCheckedChange={(next) => field.onChange(next)}
          />
        </div>
      )}
    />
  );
}
