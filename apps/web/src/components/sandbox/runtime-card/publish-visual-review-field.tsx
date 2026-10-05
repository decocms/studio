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
export interface PublishVisualReviewFieldProps<T extends FieldValues> {
  control: Control<T>;
}

export function PublishVisualReviewField<T extends FieldValues>({
  control,
}: PublishVisualReviewFieldProps<T>) {
  const t = useT();
  return (
    <Controller
      control={control}
      name={"metadata.publishVisualReview" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="publish-visual-review"
              className="font-normal text-foreground"
            >
              {t("sandbox.publishVisualReviewField.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.publishVisualReviewField.description")}
            </p>
          </div>
          <Switch
            id="publish-visual-review"
            className="shrink-0"
            checked={(field.value as boolean | null | undefined) ?? false}
            onCheckedChange={(next) => field.onChange(next)}
          />
        </div>
      )}
    />
  );
}
