import { Suspense } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { FileSearch02, GitMerge, ShieldTick } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useRepoFlag,
  useRepoHasOverrides,
  useSetRepoFlag,
} from "@/hooks/use-organization-settings";
import { useConnections } from "@/sdk";
import { listRepoScopeLabels } from "@decocms/shared/github-repo-scope";
import type { RepoOverridableFlag } from "@decocms/shared/organization/schema";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { ReactNode } from "react";

/** The three review toggles a single repository may decide for itself. */
const REPO_TOGGLES: {
  flag: RepoOverridableFlag;
  icon: ReactNode;
  labelKey: TranslationKey;
}[] = [
  {
    flag: "qa_agent_enabled",
    icon: <ShieldTick size={14} />,
    labelKey: "settings.review.qaAgentShort",
  },
  {
    flag: "code_reviewer_enabled",
    icon: <FileSearch02 size={14} />,
    labelKey: "settings.review.codeReviewerShort",
  },
  {
    flag: "auto_merge",
    icon: <GitMerge size={14} />,
    labelKey: "settings.review.autoMergeShort",
  },
];

/**
 * Per-repo overrides of the review settings above.
 *
 * The three toggles were workspace-wide, so a workspace with several
 * repositories had to run the same review setup on all of them — one repo
 * wanting reviewers but not auto-merge forced that choice on the rest. Each row
 * starts on the workspace default and only stores what it deviates on, so a
 * workspace that never touches this section behaves exactly as before.
 */
export function RepoReviewSettings() {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <RepoRows />
    </Suspense>
  );
}

/** Split out because the connection list suspends — same shape as the main-agent
 *  select, so the rest of the settings page renders while repos load. */
function RepoRows() {
  const t = useT();
  const githubConnections = useConnections({ slug: "mcp-github" }) ?? [];
  const repos = listRepoScopeLabels(githubConnections);

  if (repos.length === 0) return null;

  return (
    <SettingsSection
      title={t("settings.review.perRepoTitle")}
      description={t("settings.review.perRepoDescription")}
    >
      <SettingsCard>
        {repos.map((repo) => (
          <RepoRow key={repo} repo={repo} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function RepoRow({ repo }: { repo: string }) {
  const t = useT();
  const hasOverrides = useRepoHasOverrides(repo);
  const setRepoFlag = useSetRepoFlag();
  return (
    <SettingsCardItem
      title={repo}
      description={
        hasOverrides
          ? t("settings.review.perRepoCustom")
          : t("settings.review.perRepoInherited")
      }
      action={
        <div className="flex items-center gap-4">
          {REPO_TOGGLES.map(({ flag, icon, labelKey }) => (
            <RepoFlagToggle
              key={flag}
              repo={repo}
              flag={flag}
              icon={icon}
              labelKey={labelKey}
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasOverrides || setRepoFlag.isPending}
            onClick={() =>
              setRepoFlag.reset(repo, {
                onError: () => toast.error(t("settings.review.updateError")),
              })
            }
          >
            {t("settings.review.perRepoReset")}
          </Button>
        </div>
      }
    />
  );
}

/** One repo's one toggle. Shows the EFFECTIVE value (inherited or overridden);
 *  flipping it writes an explicit override for this repo only. */
function RepoFlagToggle({
  repo,
  flag,
  icon,
  labelKey,
}: {
  repo: string;
  flag: RepoOverridableFlag;
  icon: ReactNode;
  labelKey: TranslationKey;
}) {
  const t = useT();
  const { enabled, overridden } = useRepoFlag(repo, flag);
  const setRepoFlag = useSetRepoFlag();
  const label = `${t(labelKey)} — ${repo}`;
  return (
    <div className="flex flex-col items-center gap-1.5 w-24">
      <span
        className="flex items-center gap-1 text-[11px] text-muted-foreground"
        title={overridden ? t("settings.review.perRepoOverridden") : undefined}
      >
        {icon}
        {t(labelKey)}
        {overridden && <span className="text-foreground">*</span>}
      </span>
      <Switch
        checked={enabled}
        disabled={setRepoFlag.isPending}
        aria-label={label}
        onCheckedChange={(next) =>
          setRepoFlag.mutate(repo, flag, next, {
            onError: () => toast.error(t("settings.review.updateError")),
          })
        }
      />
    </div>
  );
}
