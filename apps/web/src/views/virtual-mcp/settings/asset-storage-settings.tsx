import { useId } from "react";
import { Controller } from "react-hook-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  SettingsCard,
  SettingsCardRow,
} from "@/components/settings/settings-section";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { useT } from "@/i18n/use-t";
import type { VirtualMcpFormReturn } from "../types";

export function AssetStorageSettings({
  form,
  onCommit,
}: {
  form: VirtualMcpFormReturn;
  onCommit: () => Promise<unknown>;
}) {
  const t = useT();
  const id = useId();
  const configs = useFileConfigsQuery();
  return (
    <SettingsCard>
      <SettingsCardRow className="grid gap-3 @min-xl/project-settings:grid-cols-[180px_minmax(0,1fr)] @min-xl/project-settings:gap-8">
        <div>
          <label htmlFor={id} className="text-sm font-medium">
            {t("virtualMcp.settings.assetStorage.label")}
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("virtualMcp.settings.assetStorage.description")}
          </p>
        </div>
        <Controller
          name="metadata.assetStorageConfigId"
          control={form.control}
          render={({ field }) => {
            const missing =
              !!field.value &&
              configs.isSuccess &&
              !configs.data.configs.some((config) => config.id === field.value);
            return (
              <div className="space-y-2">
                <Select
                  value={field.value ?? "automatic"}
                  disabled={!configs.isSuccess}
                  onValueChange={(value) => {
                    field.onChange(value === "automatic" ? null : value);
                    void onCommit();
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue
                      placeholder={t(
                        "virtualMcp.settings.assetStorage.loading",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">
                      {t("virtualMcp.settings.assetStorage.automatic")}
                    </SelectItem>
                    {missing && (
                      <SelectItem value={field.value!} disabled>
                        {t("virtualMcp.settings.assetStorage.missing")}
                      </SelectItem>
                    )}
                    {configs.data?.configs.map((config) => (
                      <SelectItem key={config.id} value={config.id}>
                        {config.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {configs.isError && (
                  <p className="text-xs text-destructive">
                    {t("virtualMcp.settings.assetStorage.loadError")}
                  </p>
                )}
              </div>
            );
          }}
        />
      </SettingsCardRow>
    </SettingsCard>
  );
}
