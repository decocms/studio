import { toast } from "sonner";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { LayoutLeft } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useNavV2, useSetOrgFlag } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

/**
 * Org-level navigation setting: the `nav_v2` flag. Reads the RESOLVED value
 * (`useNavV2`), which already defaults on for reports-only orgs, so the switch
 * reflects what the org actually sees. Flipping it writes an explicit
 * true/false, which then wins over that default.
 */
export function NavigationSettings() {
  const t = useT();
  const enabled = useNavV2();
  const setFlag = useSetOrgFlag();
  return (
    <SettingsSection
      title={t("settings.navigation.title")}
      description={t("settings.navigation.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          icon={<LayoutLeft size={16} />}
          title={t("settings.navigation.navV2Title")}
          description={t("settings.navigation.navV2Description")}
          action={
            <Switch
              checked={enabled}
              disabled={setFlag.isPending}
              aria-label={t("settings.navigation.navV2Title")}
              onCheckedChange={(next) =>
                setFlag.mutate("nav_v2", next, {
                  onError: () =>
                    toast.error(t("settings.navigation.updateError")),
                })
              }
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
