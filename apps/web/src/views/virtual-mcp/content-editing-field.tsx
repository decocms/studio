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
import {
  CmsModeSchema,
  resolveCmsMode,
  withCmsMode,
  type CmsMode,
  type VirtualMcpUILayout,
} from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";

/** The CMS mode select (`metadata.ui.layout.cms`) — whether this agent offers
 *  content editing at all. `off` removes the Site Editor's Content view from
 *  the switcher and its desktop Blocks panel. Only meaningful for agents with
 *  a clonable source, which the caller gates on. */
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
      value: "on",
      label: t("sandbox.cmsSettings.contentEditing.on"),
      description: t("sandbox.cmsSettings.contentEditing.onDescription"),
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
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <Label
                htmlFor="content-editing-mode"
                className="font-normal text-foreground"
              >
                {t("sandbox.cmsSettings.contentEditing.title")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.cmsSettings.contentEditing.description")}
              </p>
            </div>
            <Select
              value={mode}
              onValueChange={(next) => {
                const parsed = CmsModeSchema.safeParse(next);
                if (!parsed.success) return;
                field.onChange(withCmsMode(layout, parsed.data));
                onCommit();
              }}
            >
              <SelectTrigger
                id="content-editing-mode"
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
