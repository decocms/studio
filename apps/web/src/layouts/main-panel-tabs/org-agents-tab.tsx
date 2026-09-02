/** The ORG's home: who you are, what you can reach, and what your agents have
 *  been doing.
 *
 *  A centered hero (connect, greeting, one search), then the roster beside the
 *  org's recent activity, then what to do next. The roster deliberately shows
 *  only what a person made — `scopableProjects` drops the Super Agent, the
 *  Studio Pack managers and dev agents, so a fresh org lands on the empty state
 *  rather than on scaffolding it did not create. It renders as an item list
 *  (`AgentListGroup`), not the Settings › Agents card grid: this page exists to
 *  get you somewhere, that one to manage what you have. */

import { Suspense, useState, type ReactNode } from "react";
import { FolderClosed, SearchLg } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import { GitHubRepoPicker } from "@/components/github-repo-picker.tsx";
import { openCommandPalette } from "@/components/command-palette-store";
import { cn } from "@decocms/ui/lib/utils.ts";
import { GitHubIcon } from "@/components/icons/github-icon";
import { AgentListGroup } from "@/components/org-home/agent-list";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { ConnectPill } from "@/components/org-home/connect-pill";
import { firstName, greetingSlot } from "@/components/org-home/greeting";
import {
  RecentActivity,
  useRecentTasksSuspense,
} from "@/components/org-home/recent-activity";
import { useCapability } from "@/hooks/use-capability";
import { scopableProjects } from "@/hooks/use-project-scope";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { authClient } from "@/lib/auth-client";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { track } from "@/lib/posthog-client";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";

const GREETING_KEYS = {
  morning: {
    named: "home.orgHome.greetingMorning",
    bare: "home.orgHome.greetingMorningBare",
  },
  afternoon: {
    named: "home.orgHome.greetingAfternoon",
    bare: "home.orgHome.greetingAfternoonBare",
  },
  evening: {
    named: "home.orgHome.greetingEvening",
    bare: "home.orgHome.greetingEveningBare",
  },
} as const satisfies Record<
  string,
  { named: TranslationKey; bare: TranslationKey }
>;

/**
 * The home's search field, which is not a search field.
 *
 * There is exactly one search in the product — the ⌘K palette, which already
 * spans destinations, projects, settings, threads and tasks. This is its
 * trigger dressed as the input people look for, so the home does not grow a
 * second, weaker index beside it. Activating it (click, Enter, Space) opens
 * the palette; it deliberately does not open on plain focus, which would make
 * tabbing through the page pop a dialog and then re-pop it on the focus
 * returned when the dialog closes.
 */
function HomeSearch() {
  const t = useT();
  return (
    <button
      type="button"
      /** e2e's "the org home has painted" anchor: this control renders in every
       *  state of the page, unlike the roster or the activity column. */
      data-testid="org-home-search"
      onClick={() => {
        track("command_palette_opened", { source: "org_home_search" });
        openCommandPalette();
      }}
      className="flex w-full max-w-[720px] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/60"
    >
      <SearchLg className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {t("home.orgHome.searchPlaceholder")}
      </span>
      <kbd className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        ⌘K
      </kbd>
    </button>
  );
}

/** Holds the grid's height while both reads settle, so the hero does not jump
 *  when they land. Deliberately not a skeleton of the rows: their number is the
 *  thing we are waiting to learn.
 *
 *  This is a page-local boundary, which the rest of the app deliberately does
 *  NOT do — the shell has two loading states and no more. It earns the
 *  exception by making the page arrive in the right ORDER rather than adding a
 *  stage to it: the greeting and the search are ready immediately and paint
 *  immediately, so the reader can start typing while the lists resolve.
 *  Suspending the whole panel on the lists would hold back content that was
 *  never waiting on anything. */
function OrgHomeBodyFallback() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function OrgHomeBody({
  canManageAgents,
  importButton,
}: {
  canManageAgents: boolean;
  importButton: (source: string) => ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  /** Both SUSPEND, so this component renders once, with the answer to both —
   *  which is what makes the layout decision below final.
   *
   *  The page size is raised off the collection default (100) because this
   *  roster is presented as COMPLETE — the header carries a count badge, and
   *  `scopableProjects` then filters the list further, so a truncated read
   *  would show a number that is simply wrong rather than a short list. */
  const all = useVirtualMCPs({ pageSize: 1000 });
  const hasActivity = useRecentTasksSuspense().length > 0;

  const agents = scopableProjects(all).filter((a) => a.id !== org.id);
  const codeAgents = agents.filter((a) => agentHasClonableSource(a.metadata));
  const plainAgents = agents.filter((a) => !agentHasClonableSource(a.metadata));

  if (agents.length === 0) {
    return (
      <div
        className="flex items-center justify-center py-10"
        data-tour={LAYOUT_TOUR_ANCHORS.agents}
      >
        <EmptyState
          image={<FolderClosed size={48} className="text-muted-foreground" />}
          title={t("routes.agentsList.noAgentsYet")}
          description={
            canManageAgents
              ? t("home.orgAgents.importToGetStarted")
              : t("routes.agentsList.askAdminToCreate")
          }
          actions={canManageAgents && importButton("org_home_empty")}
        />
      </div>
    );
  }

  return (
    <div className="@container">
      <div
        className={cn(
          "grid grid-cols-1 gap-10 @[860px]:gap-8",
          /** Activity only earns half the width when it has something to show;
           *  with an empty board the roster spans the row instead of sitting
           *  beside a blank panel. */
          hasActivity && "@[860px]:grid-cols-2",
        )}
      >
        <section
          className="flex flex-col gap-4"
          data-tour={LAYOUT_TOUR_ANCHORS.agents}
        >
          <div className="flex h-8 items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                {t("routes.agentsList.agentsHeading")}
              </h2>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {agents.length}
              </span>
            </div>
            {canManageAgents && importButton("org_home")}
          </div>
          {/* One list, no sub-headings: the section header above already says
              "Agents" and carries the count. Repo-backed agents still lead, and
              their row badge is what tells them apart. */}
          <AgentListGroup agents={[...codeAgents, ...plainAgents]} />
        </section>

        {hasActivity && <RecentActivity agents={all} />}
      </div>
    </div>
  );
}

export function OrgAgentsTab() {
  const t = useT();
  const { data: session } = authClient.useSession();

  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const { granted: canManageAgents } = useCapability("agents:manage");

  /** Read at render, so it is right on every navigation to the home and never
   *  needs a timer. It does not tick over midnight; nobody watches it. */
  const name = firstName(session?.user?.name);
  const greeting = GREETING_KEYS[greetingSlot(new Date().getHours())];

  /** Importing a repo is the only way in from this page. Studio Pack is
   *  backfilled into every org, so after filtering the empty state IS the
   *  normal first run, and cloning a repo you already have beats a blank
   *  agent — the other two creation paths stay on Settings › Agents. */
  const importButton = (source: string) => (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        track("agent_create_clicked", { source, method: "github" });
        setGithubPickerOpen(true);
      }}
    >
      <GitHubIcon size={14} />
      {t("home.orgAgents.importFromGitHub")}
    </Button>
  );

  return (
    <Page>
      <Page.Content>
        <Page.Body className="flex flex-col gap-12 pt-0 md:pt-0">
          <div className="flex flex-col items-center gap-12 text-center">
            <ConnectPill />
            {/* Greeting and search are one unit; the pill is a separate offer,
                so the space between them is larger than the space within. */}
            <div className="flex w-full flex-col items-center gap-5">
              <h1 className="text-3xl font-medium tracking-tight text-foreground">
                {name ? t(greeting.named, { name }) : t(greeting.bare)}
              </h1>
              <HomeSearch />
            </div>
          </div>

          {/* ONE boundary over both reads. The roster and the activity
              column decide the layout together — with activity the roster
              takes half the row, without it the full width — so resolving
              them separately meant rendering "no activity" first and
              re-laying-out when it arrived, which is a shift on every visit
              to a board that has anything on it. The hero above paints
              immediately either way; only the grid waits. */}
          <Suspense fallback={<OrgHomeBodyFallback />}>
            <OrgHomeBody
              canManageAgents={canManageAgents}
              importButton={importButton}
            />
          </Suspense>
        </Page.Body>
      </Page.Content>

      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={setGithubPickerOpen}
      />
    </Page>
  );
}
