import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  Coins01,
  Cube01,
  FileSearch02,
  GitBranch01,
  GitMerge,
  Rocket01,
  SearchLg,
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
import { useConnections, useProjectContext, WellKnownOrgMCPId } from "@/sdk";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Suspense, useState } from "react";
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

/** Stable identity for a saved id list, so a re-seed can compare by CONTENT.
 *  The hook returns a fresh `[]` when the setting is unset — comparing by
 *  reference would re-seed the draft on every render and discard every edit. */
function idsKey(ids: readonly string[]): string {
  return [...ids].sort().join("\u0000");
}

/**
 * The connections Studio owns rather than the user. Mirrors
 * `isStudioOwnedConnection` on the dispatch side, which drops them from a run's
 * `orgMcps` whatever this list says — so a switch for one would be a control
 * that provably does nothing.
 */
function isStudioOwned(orgId: string, connectionId: string): boolean {
  return [
    WellKnownOrgMCPId.SELF,
    WellKnownOrgMCPId.REGISTRY,
    WellKnownOrgMCPId.COMMUNITY_REGISTRY,
    WellKnownOrgMCPId.DEV_ASSETS,
    WellKnownOrgMCPId.COMMERCE_DISCOVERY,
  ].some((id) => id(orgId) === connectionId);
}

function OrgMcpExclusionList() {
  const t = useT();
  const { org } = useProjectContext();
  const connections = useConnections();
  const saved = useCodingAgentExcludedMcps();
  const setExcluded = useSetCodingAgentExcludedMcps();

  // Edits are local until Save. One write instead of one per switch: the
  // mutation invalidates the settings query, so a per-row toggle re-fetched
  // and re-rendered the whole list under the cursor on every click.
  const [draft, setDraft] = useState<string[]>(saved);
  const [syncedWith, setSyncedWith] = useState(idsKey(saved));
  const [query, setQuery] = useState("");
  const savedKey = idsKey(saved);
  if (syncedWith !== savedKey) {
    setSyncedWith(savedKey);
    setDraft(saved);
  }

  const mountable = connections.filter(
    (connection) => !isStudioOwned(org.id, connection.id),
  );
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? mountable.filter((connection) =>
        `${connection.title} ${connection.slug ?? ""}`
          .toLowerCase()
          .includes(needle),
      )
    : mountable;

  const draftSet = new Set(draft);
  // Only the ids that still exist: a connection deleted since this was saved
  // would otherwise sit in the list forever and count as a pending change.
  const dirty =
    idsKey(draft.filter((id) => mountable.some((c) => c.id === id))) !==
    savedKey;
  const allVisibleOn =
    visible.length > 0 && visible.every((c) => !draftSet.has(c.id));

  const setAvailable = (ids: readonly string[], available: boolean) => {
    const touched = new Set(ids);
    setDraft(
      available
        ? draft.filter((id) => !touched.has(id))
        : [...new Set([...draft, ...ids])],
    );
  };

  const save = () =>
    setExcluded.mutate(
      // Prune ids whose connection is gone, so saving also tidies the list.
      draft.filter((id) => mountable.some((c) => c.id === id)),
      {
        onSuccess: () =>
          toast.success(t("settings.agentTools.orgMcpsPickSaved")),
        onError: () => toast.error(t("settings.agentTools.orgMcpsPickFailed")),
      },
    );

  return (
    <SettingsCardItem
      title={t("settings.agentTools.orgMcpsPickTitle")}
      description={t("settings.agentTools.orgMcpsPickDescription")}
    >
      <div className="mt-3 flex w-full flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchLg
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.agentTools.orgMcpsPickSearch")}
              aria-label={t("settings.agentTools.orgMcpsPickSearch")}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={visible.length === 0}
            onClick={() =>
              setAvailable(
                visible.map((c) => c.id),
                !allVisibleOn,
              )
            }
          >
            {allVisibleOn
              ? t("settings.agentTools.orgMcpsPickDisableAll")
              : t("settings.agentTools.orgMcpsPickEnableAll")}
          </Button>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-xl border border-border divide-y divide-border">
          {mountable.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t("settings.agentTools.orgMcpsPickEmpty")}
            </p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t("settings.agentTools.orgMcpsPickNoMatch")}
            </p>
          ) : (
            visible.map((connection) => {
              const label = connection.title || connection.id;
              return (
                <div
                  key={connection.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <McpAvatar icon={connection.icon} title={label} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm leading-tight">
                        {label}
                      </span>
                      {connection.slug && (
                        <span className="truncate text-xs text-muted-foreground">
                          {connection.slug}
                        </span>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={!draftSet.has(connection.id)}
                    aria-label={t("settings.agentTools.orgMcpsPickAriaLabel", {
                      name: label,
                    })}
                    onCheckedChange={(checked) =>
                      setAvailable([connection.id], checked)
                    }
                  />
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!dirty || setExcluded.isPending}
            onClick={save}
          >
            {setExcluded.isPending
              ? t("settings.agentTools.orgMcpsPickSaving")
              : t("settings.agentTools.orgMcpsPickSave")}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={setExcluded.isPending}
              onClick={() => setDraft(saved)}
            >
              {t("settings.agentTools.orgMcpsPickDiscard")}
            </Button>
          )}
        </div>
      </div>
    </SettingsCardItem>
  );
}

/** Small square avatar for a connection, falling back to its initial. */
function McpAvatar({ icon, title }: { icon: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/20">
      {icon && !failed ? (
        <img
          src={icon}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-[10px] font-semibold text-muted-foreground">
          {title.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
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
