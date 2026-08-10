import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import {
  RadioGroup,
  RadioGroupItem,
} from "@decocms/ui/components/radio-group.tsx";
import { useT } from "@/i18n/use-t.ts";

// The publish-policy radio group (`metadata.publishPolicy`): how a code agent's
// CMS/code changes reach the live site — direct publish vs. PR review. Extracted
// from the settings view so it can compose inside the CMS section. Generic over
// the parent schema, mirroring the other metadata field editors. Code-agent only
// — the caller gates on a connected GitHub repo.
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
      render={({ field }) => (
        <RadioGroup
          value={(field.value as string | null) ?? "smart"}
          onValueChange={(value) => {
            field.onChange(value);
            onCommit();
          }}
          className="gap-4"
        >
          {options.map((option) => (
            <label
              key={option.value}
              htmlFor={`publish-policy-${option.value}`}
              className="flex cursor-pointer items-start gap-3"
            >
              <RadioGroupItem
                id={`publish-policy-${option.value}`}
                value={option.value}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {option.label}
                </span>
                <span className="text-sm text-muted-foreground">
                  {option.description}
                </span>
              </div>
            </label>
          ))}
        </RadioGroup>
      )}
    />
  );
}
