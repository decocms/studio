import { toast } from "sonner";
import { Switch } from "@deco/ui/components/switch.tsx";
import { FileSearch02, GitMerge, ShieldTick } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useOrgFlag, useSetOrgFlag } from "@/hooks/use-organization-settings";
import type { OrgFlags } from "@decocms/shared/organization/schema";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { ReactNode } from "react";

/**
 * Org-level review settings: which automated reviewers run on a task's PR once
 * it's In Review, and whether an all-approved PR is merged automatically.
 */
export function ReviewSettings() {
  const t = useT();
  return (
    <SettingsSection
      title={t("settings.review.title")}
      description={t("settings.review.description")}
    >
      <SettingsCard>
        <FlagToggle
          flag="qa_agent_enabled"
          icon={<ShieldTick size={16} />}
          titleKey="settings.review.qaAgentTitle"
          descriptionKey="settings.review.qaAgentDescription"
        />
        <FlagToggle
          flag="code_reviewer_enabled"
          icon={<FileSearch02 size={16} />}
          titleKey="settings.review.codeReviewerTitle"
          descriptionKey="settings.review.codeReviewerDescription"
        />
        <FlagToggle
          flag="auto_merge"
          icon={<GitMerge size={16} />}
          titleKey="settings.review.autoMergeTitle"
          descriptionKey="settings.review.autoMergeDescription"
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function FlagToggle({
  flag,
  icon,
  titleKey,
  descriptionKey,
}: {
  flag: keyof OrgFlags;
  icon: ReactNode;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}) {
  const t = useT();
  const enabled = useOrgFlag(flag);
  const setFlag = useSetOrgFlag();
  return (
    <SettingsCardItem
      icon={icon}
      title={t(titleKey)}
      description={t(descriptionKey)}
      action={
        <Switch
          checked={enabled}
          disabled={setFlag.isPending}
          onCheckedChange={(next) =>
            setFlag.mutate(flag, next, {
              onError: () => toast.error(t("settings.review.updateError")),
            })
          }
        />
      }
    />
  );
}
