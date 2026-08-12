import { Beaker02 } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import { FlagToggle } from "@/components/settings/review-settings";
import { useT } from "@/i18n/use-t.ts";

/**
 * Experimental org flags — opt-in product previews that are safe to toggle per
 * org while they're still being built (currently the task-based flow).
 */
export function ExperimentalSettings() {
  const t = useT();
  return (
    <SettingsSection
      title={t("settings.experimental.title")}
      description={t("settings.experimental.description")}
    >
      <SettingsCard>
        <FlagToggle
          flag="taskBasedFlow"
          icon={<Beaker02 size={16} />}
          titleKey="settings.experimental.taskBasedFlowTitle"
          descriptionKey="settings.experimental.taskBasedFlowDescription"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
