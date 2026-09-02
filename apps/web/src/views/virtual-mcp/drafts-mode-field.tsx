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
 * The Draft & Releases mode toggle (`metadata.draftsMode`): gates the drafts UX
 * for this code agent — the releases switcher, read-only production, and
 * publish-to-production. Off keeps the classic branch/PR picker.
 */
export interface DraftsModeFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Settings auto-save on change — persist immediately (blur-equivalent). */
  onCommit: () => void;
}

export function DraftsModeField<T extends FieldValues>({
  control,
  onCommit,
}: DraftsModeFieldProps<T>) {
  const t = useT();
  return (
    <Controller
      name={"metadata.draftsMode" as FieldPath<T>}
      control={control}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="drafts-mode"
              className="font-normal text-foreground"
            >
              {t("virtualMcp.virtualMcp.draftsModeTitle")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("virtualMcp.virtualMcp.draftsModeDescription")}
            </p>
          </div>
          <Switch
            id="drafts-mode"
            checked={field.value === true}
            onCheckedChange={(checked) => {
              field.onChange(checked);
              onCommit();
            }}
          />
        </div>
      )}
    />
  );
}
