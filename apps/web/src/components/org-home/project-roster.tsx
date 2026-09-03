/**
 * The org home's project list — the projects a person made, most recent first,
 * above the feed.
 *
 * The roster is what the home is FOR: it gets you into a project. It sits above
 * the feed because "where do I go" comes before "what happened", and it is the
 * one place on the home that is always there — the feed hides itself when the
 * board is empty, but a project you can open is never nothing to show.
 *
 * It shows the SIX most recent and defers the rest to "See all" — the home is a
 * launchpad, not the full roster, which lives at Settings › Agents. Each project
 * is just its mark and its name — no card, no description, no footer. The home
 * is a way IN; the lighter the row, the faster the eye finds the one it wants.
 */

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import { AgentAvatar } from "@/components/agent-icon";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { landingTabIdFor } from "@/layouts/main-panel-tabs/tab-id";
import { useProjectContext } from "@/sdk";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

/** Projects the home shows before it defers to Settings › Agents. */
const MAX_PROJECTS = 6;

function ProjectRosterItem({ project }: { project: VirtualMCPEntity }) {
  const navigateToAgent = useNavigateToAgent();
  return (
    <button
      type="button"
      onClick={() => {
        track("org_home_project_clicked");
        navigateToAgent(project.id, {
          view: landingTabIdFor(project.metadata?.ui?.layout),
        });
      }}
      className="flex min-w-0 items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-accent/60"
    >
      <AgentAvatar icon={project.icon} name={project.title} size="sm+" />
      <span className="truncate text-sm font-medium text-foreground">
        {project.title}
      </span>
    </button>
  );
}

export function ProjectRoster({
  projects,
  action,
}: {
  projects: VirtualMCPEntity[];
  /** The section's own control — today, "Import from GitHub". Passed in rather
   *  than imported so the roster owns no creation path. */
  action?: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  /** Most recent first, then capped — the home leads with what you touched last
   *  and hands the tail to "See all". */
  const recent = [...projects]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, MAX_PROJECTS);
  const hasMore = projects.length > MAX_PROJECTS;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-foreground">
          {t("home.projects.heading")}
        </h2>
        {action}
      </div>
      {/* `@container`, so the grid answers to this reading column's width rather
          than the viewport — the home caps at 720px, where two columns fit. */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-1 @lg:grid-cols-2">
          {recent.map((project) => (
            <ProjectRosterItem key={project.id} project={project} />
          ))}
        </div>
      </div>
      {hasMore && (
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/$org/settings/agents" params={{ org: org.slug }}>
              {t("home.projects.seeAll")}
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}
