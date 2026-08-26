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
import {
  resolveCmsMode,
  withCmsMode,
  type CmsMode,
  type VirtualMcpUILayout,
} from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";

/**
 * The CMS mode radio group (`metadata.ui.layout.cms`): whether this agent
 * offers content editing at all, and where the preview lands when it does.
 * `off` hides both entry points — the Content tab and the Preview toolbar's CMS
 * toggle. Sits next to PublishPolicyField in the CMS section and follows the
 * same shape. Only meaningful for agents with a clonable source — the caller
 * gates on it.
 */
export interface ContentEditingFieldProps<T extends FieldValues> {
  control: Control<T>;
  /** Settings auto-save on change — persist immediately (blur-equivalent). */
  onCommit: () => void;
}

export function ContentEditingField<T extends FieldValues>({
  control,
  onCommit,
}: ContentEditingFieldProps<T>) {
  const t = useT();
  const options = [
    {
      value: "manual",
      label: t("sandbox.cmsSettings.contentEditing.manual"),
      description: t("sandbox.cmsSettings.contentEditing.manualDescription"),
    },
    {
      value: "auto",
      label: t("sandbox.cmsSettings.contentEditing.auto"),
      description: t("sandbox.cmsSettings.contentEditing.autoDescription"),
    },
    {
      value: "off",
      label: t("sandbox.cmsSettings.contentEditing.off"),
      description: t("sandbox.cmsSettings.contentEditing.offDescription"),
    },
  ] as const satisfies ReadonlyArray<{
    value: CmsMode;
    label: string;
    description: string;
  }>;
  return (
    <Controller
      /* The whole layout object, not the leaf: `withCmsMode` also clears the
         settings the new mode invalidates. */
      name={"metadata.ui.layout" as FieldPath<T>}
      control={control}
      render={({ field }) => {
        const layout = (field.value ?? null) as VirtualMcpUILayout | null;
        return (
          <RadioGroup
            value={resolveCmsMode(layout)}
            onValueChange={(value) => {
              field.onChange(withCmsMode(layout, value as CmsMode));
              onCommit();
            }}
            className="gap-4"
          >
            {options.map((option) => (
              <label
                key={option.value}
                htmlFor={`content-editing-${option.value}`}
                className="flex cursor-pointer items-start gap-3"
              >
                <RadioGroupItem
                  id={`content-editing-${option.value}`}
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
        );
      }}
    />
  );
}
