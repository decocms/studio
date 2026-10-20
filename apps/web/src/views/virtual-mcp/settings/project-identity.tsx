import { useId } from "react";
import { Controller } from "react-hook-form";
import { Input } from "@decocms/ui/components/input.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { IconPicker } from "@/components/icon-picker";
import {
  SettingsCard,
  SettingsCardRow,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t";
import type { VirtualMcpFormReturn } from "../types";

export function ProjectIdentity({
  form,
  onCommit,
}: {
  form: VirtualMcpFormReturn;
  onCommit: () => Promise<unknown>;
}) {
  const t = useT();
  const id = useId();
  const rowClass =
    "grid gap-3 @min-xl/project-settings:grid-cols-[180px_minmax(0,1fr)] @min-xl/project-settings:gap-8";

  return (
    <SettingsCard>
      <SettingsCardRow className={rowClass}>
        <div>
          <p className="text-sm font-medium">
            {t("virtualMcp.settings.identity.icon")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("virtualMcp.settings.identity.iconDescription")}
          </p>
        </div>
        <Controller
          name="icon"
          control={form.control}
          render={({ field }) => (
            <div className="justify-self-start">
              <IconPicker
                value={field.value ?? null}
                onChange={(icon) => {
                  field.onChange(icon);
                  onCommit();
                }}
                onColorChange={(color) => {
                  form.setValue("metadata.ui.themeColor", color, {
                    shouldDirty: true,
                  });
                  onCommit();
                }}
                name={
                  form.watch("title") ||
                  t("virtualMcp.virtualMcp.agentNameFallback")
                }
                size="md"
                avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
              />
            </div>
          )}
        />
      </SettingsCardRow>
      <SettingsCardRow className={rowClass}>
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          {t("virtualMcp.settings.identity.name")}
        </label>
        <Controller
          name="title"
          control={form.control}
          render={({ field }) => (
            <Input
              {...field}
              id={`${id}-name`}
              value={field.value ?? ""}
              onBlur={() => {
                field.onBlur();
                onCommit();
              }}
              placeholder={t("virtualMcp.virtualMcp.agentNamePlaceholder")}
            />
          )}
        />
      </SettingsCardRow>
      <SettingsCardRow className={rowClass}>
        <label htmlFor={`${id}-description`} className="text-sm font-medium">
          {t("virtualMcp.settings.identity.description")}
        </label>
        <Controller
          name="description"
          control={form.control}
          render={({ field }) => (
            <Textarea
              {...field}
              id={`${id}-description`}
              value={field.value ?? ""}
              onBlur={() => {
                field.onBlur();
                onCommit();
              }}
              placeholder={t("virtualMcp.virtualMcp.descriptionPlaceholder")}
              className="min-h-24 resize-y"
            />
          )}
        />
      </SettingsCardRow>
    </SettingsCard>
  );
}
