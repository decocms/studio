import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import type { ContentCheck } from "@decocms/shared/sdk/types/virtual-mcp";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";

/**
 * The content-check select (`metadata.contentCheck`): what the CMS Publish
 * checks for required fields left missing. Shares its shape with
 * PublishPolicyField in the same section.
 */
export interface ContentCheckFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Settings auto-save on change — persist immediately (blur-equivalent). */
  onCommit: () => void;
}

export function ContentCheckField<T extends FieldValues>({
  control,
  onCommit,
}: ContentCheckFieldProps<T>) {
  const t = useT();
  const options: ReadonlyArray<{
    value: ContentCheck;
    label: string;
    description: string;
  }> = [
    {
      value: "none",
      label: t("virtualMcp.contentCheck.none"),
      description: t("virtualMcp.contentCheck.noneDescription"),
    },
    {
      value: "changes",
      label: t("virtualMcp.contentCheck.changes"),
      description: t("virtualMcp.contentCheck.changesDescription"),
    },
    {
      value: "all",
      label: t("virtualMcp.contentCheck.all"),
      description: t("virtualMcp.contentCheck.allDescription"),
    },
  ];
  return (
    <Controller
      name={"metadata.contentCheck" as FieldPath<T>}
      control={control}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="content-check"
              className="font-normal text-foreground"
            >
              {t("virtualMcp.contentCheck.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("virtualMcp.contentCheck.description")}
            </p>
          </div>
          <Select
            value={(field.value as ContentCheck | null) ?? "none"}
            onValueChange={(value) => {
              field.onChange(value);
              onCommit();
            }}
          >
            <SelectTrigger id="content-check" className="w-44 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-80">
              {options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  description={option.description}
                >
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
