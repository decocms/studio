import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";

// Radix Select cannot hold an empty value, so "automatic" rides a sentinel
// that is stored as null (the preview server's hint decides).
const AUTO = "auto";

/**
 * The preview-device select (`metadata.previewDevice`): which device the
 * preview canvas opens on. Mirrors PublishPolicyField.
 */
export interface PreviewDeviceFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Settings auto-save on change — persist immediately (blur-equivalent). */
  onCommit: () => void;
}

export function PreviewDeviceField<T extends FieldValues>({
  control,
  onCommit,
}: PreviewDeviceFieldProps<T>) {
  const t = useT();
  const options = [
    { value: AUTO, label: t("sandbox.cmsSettings.previewDevice.auto") },
    { value: "mobile", label: t("sandbox.cmsSettings.previewDevice.mobile") },
    { value: "desktop", label: t("sandbox.cmsSettings.previewDevice.desktop") },
  ] as const;
  return (
    <Controller
      name={"metadata.previewDevice" as FieldPath<T>}
      control={control}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="preview-device"
              className="font-normal text-foreground"
            >
              {t("sandbox.cmsSettings.previewDevice.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.cmsSettings.previewDevice.description")}
            </p>
          </div>
          <Select
            value={(field.value as string | null) ?? AUTO}
            onValueChange={(value) => {
              field.onChange(value === AUTO ? null : value);
              onCommit();
            }}
          >
            <SelectTrigger
              id="preview-device"
              className="w-44 shrink-0 text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    />
  );
}
