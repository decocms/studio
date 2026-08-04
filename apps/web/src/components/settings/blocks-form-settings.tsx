import { toast } from "sonner";
import { Switch } from "@deco/ui/components/switch.tsx";
import { HelpCircle } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useOrgFlag, useSetOrgFlag } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

/**
 * Org-level, opt-in toggle for how the blocks form editor renders a field's
 * schema description: the default inline text below the title, or a hover
 * tooltip on the title.
 */
export function BlocksFormSettings() {
  const t = useT();
  const tooltipsEnabled = useOrgFlag("field_description_tooltips");
  const setFlag = useSetOrgFlag();
  return (
    <SettingsSection
      title={t("settings.blocksForm.title")}
      description={t("settings.blocksForm.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          icon={<HelpCircle size={16} />}
          title={t("settings.blocksForm.descriptionTooltipsTitle")}
          description={t("settings.blocksForm.descriptionTooltipsDescription")}
          action={
            <Switch
              checked={tooltipsEnabled}
              disabled={setFlag.isPending}
              onCheckedChange={(next) =>
                setFlag.mutate("field_description_tooltips", next, {
                  onError: () =>
                    toast.error(t("settings.blocksForm.updateError")),
                })
              }
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
