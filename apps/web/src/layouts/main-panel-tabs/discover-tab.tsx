/**
 * Discover — what this org does NOT have yet.
 *
 * The sidebar's fifth destination, and the reason none of the other four ever
 * has to be hidden. Hiding Reports until an org owned a diagnostic shipped once
 * and was reverted, because it removed the only in-product way to ask for one
 * (see `reports-tab.tsx`). Withholding a shortcut must never withhold the
 * purchase — so anything withheld is named here instead.
 *
 * Three bands, in the order a person needs them: finish setting up, turn on
 * what you already qualify for, then add something new.
 *
 * Everything here reads data the shell already fetches, so this page states the
 * gates the tab bar enforces silently rather than re-deriving them.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Database01,
  File02,
  Image01,
  Plus,
  Users01,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { GitHubIcon } from "@/components/icons/github-icon";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useProjectContext, useConnections } from "@/sdk";
import { useProjectScope } from "@/hooks/use-project-scope";
import { hasOwnConnection } from "@/lib/seeded-connections";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useMembersQuery } from "@/hooks/use-members";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { resolveCmsMode } from "@decocms/shared/sdk/types";

interface SetupStep {
  key: string;
  title: string;
  body: string;
  done: boolean;
  icon: ReactNode;
  action: ReactNode;
}

/**
 * The org's unfinished setup, derived from what the shell already knows.
 *
 * Deliberately not persisted: a checklist stored server-side drifts from the
 * thing it describes, and every one of these is cheap to observe directly.
 */
function useSetupSteps(): SetupStep[] {
  const t = useT();
  const { org } = useProjectContext();
  const connections = useConnections();
  const github = useConnections({ slug: "mcp-github" });
  const { projects } = useProjectScope();
  /** Non-suspense: this list sits inside the setup band, which must paint. */
  const members = useMembersQuery();

  const orgParams = { org: org.slug };

  return [
    {
      key: "connect",
      title: t("discover.setup.connectTitle"),
      body: t("discover.setup.connectBody"),
      done: hasOwnConnection(connections, org.id),
      icon: <Database01 size={18} />,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link
            to="/$org/settings/connections"
            params={orgParams}
            search={{ tab: "all" as const }}
          >
            {t("discover.setup.connectAction")}
          </Link>
        </Button>
      ),
    },
    {
      key: "github",
      title: t("discover.setup.githubTitle"),
      body: t("discover.setup.githubBody"),
      done: github.length > 0,
      icon: <GitHubIcon className="size-[18px]" />,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link
            to="/$org/settings/connections"
            params={orgParams}
            search={{ tab: "all" as const }}
          >
            {t("discover.setup.githubAction")}
          </Link>
        </Button>
      ),
    },
    {
      key: "project",
      title: t("discover.setup.projectTitle"),
      body: t("discover.setup.projectBody"),
      done: projects.length > 0,
      icon: <Plus size={18} />,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link
            to={DESTINATION_ROUTE.agents}
            params={{ org: org.slug, panel: undefined }}
            search={{ virtualmcpid: undefined }}
          >
            {t("discover.setup.projectAction")}
          </Link>
        </Button>
      ),
    },
    {
      key: "invite",
      title: t("discover.setup.inviteTitle"),
      body: t("discover.setup.inviteBody"),
      /** Membership, not a click: a step that can never complete makes the
       *  whole checklist permanently unfinished. A second member is the
       *  observable form of "you invited someone". */
      done: (members.data?.data?.members ?? []).length > 1,
      icon: <Users01 size={18} />,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link to="/$org/settings/members" params={orgParams}>
            {t("discover.setup.inviteAction")}
          </Link>
        </Button>
      ),
    },
  ];
}

/** A capability the org can turn on, and the gate standing in the way. */
interface Capability {
  key: string;
  title: string;
  requirement: string;
  satisfied: boolean;
  icon: ReactNode;
}

/**
 * The gates the main-panel tab bar already enforces, stated in prose.
 *
 * The tab bar hides Content / Assets / Git when their gate fails, which is
 * correct — a tab that cannot work should not be offered — but silent. This is
 * where the silence gets explained.
 */
function useCapabilities(): Capability[] {
  const t = useT();
  const { projects } = useProjectScope();
  const github = useConnections({ slug: "mcp-github" });
  const fileConfigs = useFileConfigsQuery();

  const anyRepo = projects.some((project) => getActiveGithubRepo(project));
  /** Content's gate, as the tab bar states it (`source-system-tabs.ts`): a
   *  checked-out source AND a CMS mode other than `off`. A repo alone is not
   *  content editing. */
  const anyCmsProject = projects.some(
    (project) =>
      !!getActiveGithubRepo(project) &&
      resolveCmsMode(project.metadata?.ui?.layout) !== "off",
  );
  /** Assets' gate, likewise: a file config bound to THIS project's site slug,
   *  not merely some object storage somewhere in the org. */
  const anyAssetsProject = projects.some((project) =>
    matchSiteSlugConfig(
      fileConfigs.data?.configs ?? [],
      resolveAgentSiteSlug(project),
    ),
  );

  return [
    {
      key: "preview",
      title: t("discover.capabilities.previewTitle"),
      requirement: t("discover.capabilities.previewRequirement"),
      satisfied: anyRepo,
      icon: <File02 size={18} />,
    },
    {
      key: "git",
      title: t("discover.capabilities.gitTitle"),
      requirement: t("discover.capabilities.gitRequirement"),
      satisfied: github.length > 0 && anyRepo,
      icon: <GitHubIcon className="size-[18px]" />,
    },
    {
      key: "content",
      title: t("discover.capabilities.contentTitle"),
      requirement: t("discover.capabilities.contentRequirement"),
      satisfied: anyCmsProject,
      icon: <File02 size={18} />,
    },
    {
      key: "assets",
      title: t("discover.capabilities.assetsTitle"),
      requirement: t("discover.capabilities.assetsRequirement"),
      satisfied: anyAssetsProject,
      icon: <Image01 size={18} />,
    },
  ];
}

function Band({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

export function DiscoverTab() {
  const t = useT();
  const { org } = useProjectContext();
  const steps = useSetupSteps();
  const capabilities = useCapabilities();
  const outstanding = steps.filter((step) => !step.done);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 p-6 md:p-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-foreground">
            {t("discover.title")}
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t("discover.subtitle")}
          </p>
        </header>

        <Band
          title={t("discover.setup.title")}
          description={
            outstanding.length === 0
              ? t("discover.setup.allDone")
              : t("discover.setup.description")
          }
        >
          <ul className="flex flex-col gap-2">
            {steps.map((step) => (
              <li
                key={step.key}
                className={cn(
                  "flex items-start gap-3 rounded-xl border border-border bg-card p-4",
                  step.done && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                    step.done
                      ? "bg-success/10 text-success"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {step.done ? <Check size={18} /> : step.icon}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {step.title}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {step.body}
                  </span>
                </div>
                {!step.done && <div className="shrink-0">{step.action}</div>}
              </li>
            ))}
          </ul>
        </Band>

        <Band
          title={t("discover.capabilities.title")}
          description={t("discover.capabilities.description")}
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {capabilities.map((capability) => (
              <li
                key={capability.key}
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-4"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                    capability.satisfied
                      ? "bg-success/10 text-success"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {capability.satisfied ? <Check size={18} /> : capability.icon}
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {capability.title}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {capability.satisfied
                      ? t("discover.capabilities.ready")
                      : capability.requirement}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Band>

        <Band
          title={t("discover.catalog.title")}
          description={t("discover.catalog.description")}
        >
          <div>
            <Button asChild size="lg">
              <Link
                to="/$org/settings/connections"
                params={{ org: org.slug }}
                search={{ tab: "all" as const }}
                onClick={() => track("discover_catalog_opened", {})}
              >
                {t("discover.catalog.action")}
                <ArrowRight size={18} />
              </Link>
            </Button>
          </div>
        </Band>
      </div>
    </div>
  );
}
