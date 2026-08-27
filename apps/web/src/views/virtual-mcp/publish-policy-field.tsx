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

/**
 * The publish-policy select (`metadata.publishPolicy`): how a code agent's
 * CMS/code changes reach the live site — direct publish vs. PR review. Shares
 * its shape with ContentEditingField in the same section. Code-agent only —
 * the caller gates on a connected GitHub repo.
 */
export interface PublishPolicyFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Settings auto-save on change — persist immediately (blur-equivalent). */
  onCommit: () => void;
}

export function PublishPolicyField<T extends FieldValues>({
  control,
  onCommit,
}: PublishPolicyFieldProps<T>) {
  const t = useT();
  const options = [
    {
      value: "smart",
      label: t("virtualMcp.virtualMcp.publishPolicySmart"),
      description: t("virtualMcp.virtualMcp.publishPolicySmartDescription"),
    },
    {
      value: "code-review",
      label: t("virtualMcp.virtualMcp.publishPolicyCodeReview"),
      description: t(
        "virtualMcp.virtualMcp.publishPolicyCodeReviewDescription",
      ),
    },
    {
      value: "open",
      label: t("virtualMcp.virtualMcp.publishPolicyOpen"),
      description: t("virtualMcp.virtualMcp.publishPolicyOpenDescription"),
    },
  ] as const;
  return (
    <Controller
      name={"metadata.publishPolicy" as FieldPath<T>}
      control={control}
      render={({ field }) => {
        const policy = (field.value as string | null) ?? "smart";
        return (
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <Label
                htmlFor="publish-policy"
                className="font-normal text-foreground"
              >
                {t("virtualMcp.virtualMcp.publishing")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("virtualMcp.virtualMcp.publishingDescription")}
              </p>
            </div>
            <Select
              value={policy}
              onValueChange={(value) => {
                field.onChange(value);
                onCommit();
              }}
            >
              <SelectTrigger
                id="publish-policy"
                className="w-44 shrink-0 text-sm"
              >
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
        );
      }}
    />
  );
}
