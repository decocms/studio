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
import { SearchLg } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import { GitHubRepoPicker } from "@/components/github-repo-picker.tsx";
import { openCommandPalette } from "@/components/command-palette-store";
import { GitHubIcon } from "@/components/icons/github-icon";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { ConnectPill } from "@/components/org-home/connect-pill";
import { firstName, greetingSlot } from "@/components/org-home/greeting";
import {
  ProjectFeed,
  useOrgTasksSuspense,
} from "@/components/org-home/project-feed";
import { useCapability } from "@/hooks/use-capability";
import { scopableProjects } from "@/hooks/use-project-scope";
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
      /* `card-shadow`, not a border: the ring IS the card's border in this
         system, drawn as a shadow so it can carry the drop under it. The
         width comes from the page's column now. */
      className="card-shadow flex w-full items-center gap-2 rounded-xl bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
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
  /** Both SUSPEND, so this component renders once with the answer to both and
   *  the feed is built in a single pass.
   *
   *  The page size is raised off the collection default (100) because this
   *  roster is presented as COMPLETE — the header carries a count badge, and
   *  `scopableProjects` then filters the list further, so a truncated read
   *  would show a number that is simply wrong rather than a short list. */
  const all = useVirtualMCPs({ pageSize: 1000 });
  const tasks = useOrgTasksSuspense();

  const agents = scopableProjects(all).filter((a) => a.id !== org.id);

  if (agents.length === 0) {
    return (
      <div
        className="flex items-center justify-center py-10"
        data-tour={LAYOUT_TOUR_ANCHORS.agents}
      >
        <EmptyState
          image={null}
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
    <ProjectFeed
      projects={agents}
      tasks={tasks}
      action={canManageAgents && importButton("org_home")}
    />
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
        {/* One reading column for the whole page: the search field was already
            capped at 720px, so a full-width feed under it read as a second,
            wider page stapled to the first. */}
        <Page.Body
          maxWidth="max-w-[720px]"
          className="flex flex-col gap-12 pt-0 md:pt-0"
        >
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
