import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import {
  CmsModeSchema,
  resolveCmsMode,
  withCmsMode,
  type CmsMode,
  type VirtualMcpUILayout,
} from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";

/**
 * The CMS mode control (`metadata.ui.layout.cms`): whether this agent offers
 * content editing at all, and where the preview lands when it does. `off` hides
 * both entry points — the Content tab and the Preview toolbar's CMS toggle.
 * Ordered by how much CMS each mode gives, so the three read as one scale.
 * Only meaningful for agents with a clonable source — the caller gates on it.
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
      value: "off",
      label: t("sandbox.cmsSettings.contentEditing.off"),
      description: t("sandbox.cmsSettings.contentEditing.offDescription"),
    },
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
        const mode = resolveCmsMode(layout);
        return (
          <div className="flex flex-col gap-2">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={mode}
              aria-label={t("sandbox.cmsSettings.contentEditing.title")}
              onValueChange={(next) => {
                // Radix yields "" when the active item is clicked again.
                const parsed = CmsModeSchema.safeParse(next);
                if (!parsed.success) return;
                field.onChange(withCmsMode(layout, parsed.data));
                onCommit();
              }}
            >
              {options.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="h-8 px-3 text-sm"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {options.find((option) => option.value === mode)?.description}
            </p>
          </div>
        );
      }}
    />
  );
}
