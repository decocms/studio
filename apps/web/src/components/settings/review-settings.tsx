import { toast } from "sonner";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  Coins01,
  Cube01,
  FileSearch02,
  GitBranch01,
  GitMerge,
  Rocket01,
  Terminal,
  UserSquare,
} from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useAutoResolveConflicts,
  useCodingAgentExcludedMcps,
  useOrgFlag,
  useSetCodingAgentExcludedMcps,
  useSetOrgFlag,
} from "@/hooks/use-organization-settings";
import { useConnections } from "@/sdk";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Suspense } from "react";
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
          flag="reviewer_enabled"
          icon={<FileSearch02 size={16} />}
          titleKey="settings.review.reviewerTitle"
          descriptionKey="settings.review.reviewerDescription"
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
        <AutoResolveConflictsToggle />
        <FlagToggle
          flag="delivery_lanes_enabled"
          icon={<Rocket01 size={16} />}
          titleKey="settings.review.deliveryLanesTitle"
          descriptionKey="settings.review.deliveryLanesDescription"
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

/**
 * What a coding-agent run (the Super Agent, the reviewers) can reach beyond its
 * own checkout. Its own section, not part of the reviewer card above: this is
 * about the tools a run holds, not about who reviews its work.
 */
export function AgentToolsSettings() {
  const t = useT();
  return (
    <SettingsSection
      title={t("settings.agentTools.title")}
      description={t("settings.agentTools.description")}
    >
      <SettingsCard>
        <FlagToggle
          flag="coding_agent_org_mcps"
          icon={<Cube01 size={16} />}
          titleKey="settings.agentTools.orgMcpsTitle"
          descriptionKey="settings.agentTools.orgMcpsDescription"
        />
        <OrgMcpExclusions />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Which of the org's connections a run may mount, once the toggle above is on.
 *
 * Only shown when it IS on: with it off nothing is mounted anyway, and a list
 * of switches that change nothing reads as broken. Stored as the EXCLUDED ids
 * (`coding_agent_mcp_excluded`) but rendered as "available to runs", because
 * the answer people want to read off the row is what a run can reach — and
 * because a connection added after this was configured should default to
 * available, which an exclusion list gives for free and an allowlist would not.
 */
function OrgMcpExclusions() {
  const enabled = useOrgFlag("coding_agent_org_mcps");
  if (!enabled) return null;
  return (
    <Suspense fallback={<OrgMcpExclusionsFallback />}>
      <OrgMcpExclusionList />
    </Suspense>
  );
}

function OrgMcpExclusionsFallback() {
  const t = useT();
  return (
    <SettingsCardItem title={t("settings.agentTools.orgMcpsPickTitle")}>
      <Skeleton className="mt-3 h-24 w-full" />
    </SettingsCardItem>
  );
}

function OrgMcpExclusionList() {
  const t = useT();
  const connections = useConnections();
  const excluded = useCodingAgentExcludedMcps();
  const setExcluded = useSetCodingAgentExcludedMcps();
  const excludedSet = new Set(excluded);

  const toggle = (id: string, available: boolean) => {
    const next = available
      ? excluded.filter((x) => x !== id)
      : [...new Set([...excluded, id])];
    setExcluded.mutate(next, {
      onError: () => toast.error(t("settings.agentTools.orgMcpsPickFailed")),
    });
  };

  return (
    <SettingsCardItem
      title={t("settings.agentTools.orgMcpsPickTitle")}
      description={t("settings.agentTools.orgMcpsPickDescription")}
    >
      <div className="mt-3 flex w-full flex-col divide-y divide-border rounded-xl border border-border">
        {connections.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {t("settings.agentTools.orgMcpsPickEmpty")}
          </p>
        ) : (
          connections.map((connection) => {
            const available = !excludedSet.has(connection.id);
            const label = connection.title || connection.id;
            return (
              <div
                key={connection.id}
                className="flex items-center justify-between gap-3 p-3"
              >
                <span className="min-w-0 truncate text-sm">{label}</span>
                <Switch
                  checked={available}
                  disabled={setExcluded.isPending}
                  aria-label={t("settings.agentTools.orgMcpsPickAriaLabel", {
                    name: label,
                  })}
                  onCheckedChange={(checked) => toggle(connection.id, checked)}
                />
              </div>
            );
          })
        )}
      </div>
    </SettingsCardItem>
  );
}

/**
 * Which coding agent backs Code Agent chats. Lives on General, not the board
 * settings: it's about the org's agents, not about how tasks get reviewed.
 */
export function CodeAgentsSettings() {
  const t = useT();
  return (
    <SettingsSection title={t("sidebar.agentsSection.codeAgents")}>
      <SettingsCard>
        <FlagToggle
          flag="coding_agents_claude_code"
          icon={<Terminal size={16} />}
          titleKey="settings.agentTools.codingAgentsClaudeCodeTitle"
          descriptionKey="settings.agentTools.codingAgentsClaudeCodeDescription"
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Conflict resolution reads through `useAutoResolveConflicts`, not the raw
 * flag: unset it follows `auto_merge`, so a switch bound to the raw value would
 * read off while the server is resolving conflicts.
 */
function AutoResolveConflictsToggle() {
  const enabled = useAutoResolveConflicts();
  return (
    <FlagToggle
      flag="auto_resolve_conflicts"
      icon={<GitBranch01 size={16} />}
      titleKey="settings.review.autoResolveConflictsTitle"
      descriptionKey="settings.review.autoResolveConflictsDescription"
      enabled={enabled}
    />
  );
}

/** One org flag as a switch. Shared with the other org-settings sections. */
function FlagToggle({
  flag,
  icon,
  titleKey,
  descriptionKey,
  enabled: enabledOverride,
}: {
  flag: keyof OrgFlags;
  icon: ReactNode;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** Effective value when the flag's default is derived rather than a plain
   *  `orgFlagEnabled` read. */
  enabled?: boolean;
}) {
  const t = useT();
  const flagValue = useOrgFlag(flag);
  const enabled = enabledOverride ?? flagValue;
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
