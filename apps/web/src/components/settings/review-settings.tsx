import { toast } from "sonner";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  Coins01,
  FileSearch02,
  GitMerge,
  ShieldTick,
  UserSquare,
} from "@untitledui/icons";
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
          flag="cheap_reviewer_model"
          icon={<Coins01 size={16} />}
          titleKey="settings.review.cheapReviewerModelTitle"
          descriptionKey="settings.review.cheapReviewerModelDescription"
        />
        <FlagToggle
          flag="auto_merge"
          icon={<GitMerge size={16} />}
          titleKey="settings.review.autoMergeTitle"
          descriptionKey="settings.review.autoMergeDescription"
        />
        <FlagToggle
          flag="auto_assign_report_tasks_to_super_agent"
          icon={<UserSquare size={16} />}
          titleKey="settings.review.autoAssignReportTasksTitle"
          descriptionKey="settings.review.autoAssignReportTasksDescription"
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** One org flag as a switch. Shared with the other org-settings sections. */
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
          aria-label={t(titleKey)}
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
