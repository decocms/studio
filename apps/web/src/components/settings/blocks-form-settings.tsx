import { toast } from "sonner";
import { Switch } from "@deco/ui/components/switch.tsx";
import { AlignLeft01 } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useOrgFlag, useSetOrgFlag } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

/**
 * Org-level toggle for how the blocks form editor renders a field's schema
 * description: the default hover tooltip on the title, or inline text below
 * it.
 */
export function BlocksFormSettings() {
  const t = useT();
  const inlineDescriptions = useOrgFlag("inline_field_descriptions");
  const setFlag = useSetOrgFlag();
  return (
    <SettingsSection
      title={t("settings.blocksForm.title")}
      description={t("settings.blocksForm.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          icon={<AlignLeft01 size={16} />}
          title={t("settings.blocksForm.inlineDescriptionsTitle")}
          description={t("settings.blocksForm.inlineDescriptionsDescription")}
          action={
            <Switch
              checked={inlineDescriptions}
              disabled={setFlag.isPending}
              onCheckedChange={(next) =>
                setFlag.mutate("inline_field_descriptions", next, {
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
