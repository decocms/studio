/**
 * The apps a project can launch. Which tiles appear comes from
 * `effectiveProjectSidebarViews`, the resolver the scoped sidebar uses, so the
 * two shapes cannot disagree about what a project has.
 */

import { Link } from "@tanstack/react-router";
import {
  BarChartSquare02,
  BezierCurve02,
  FileSearch02,
  FlipBackward,
  Image01,
  LayoutAlt01,
  Server01,
  Speedometer02,
  Zap,
} from "@untitledui/icons";
import type { ComponentType } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import {
  effectiveProjectSidebarViews,
  type ProjectSidebarViewId,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { track } from "@/lib/posthog-client";

/** Board and Overview are the screen this sits on. Reports is not — it is a
 *  separate destination and must stay launchable. */
type LaunchableViewId = Exclude<ProjectSidebarViewId, "overview" | "board">;

/** `to` values are `PROJECT_ROUTE` literals, so a router rename fails to
 *  compile here. */
const APPS: Record<
  LaunchableViewId,
  {
    labelKey: TranslationKey;
    captionKey: TranslationKey;
    Icon: ComponentType<{ size?: number }>;
    to: string;
    /** Tile tint, from the design system's categorical palette. */
    tone: string;
  }
> = {
  reports: {
    labelKey: "projects.apps.reports",
    captionKey: "projects.apps.reportsCaption",
    Icon: FileSearch02,
    to: PROJECT_ROUTE.reports,
    tone: "bg-chart-2/15 text-chart-2",
  },
  "site-editor": {
    labelKey: "projects.apps.siteEditor",
    captionKey: "projects.apps.siteEditorCaption",
    Icon: LayoutAlt01,
    to: PROJECT_ROUTE.siteEditor,
    tone: "bg-chart-1/15 text-chart-1",
  },
  assets: {
    labelKey: "projects.apps.assets",
    captionKey: "projects.apps.assetsCaption",
    Icon: Image01,
    to: PROJECT_ROUTE.assets,
    tone: "bg-chart-2/15 text-chart-2",
  },
  hosting: {
    labelKey: "projects.apps.hosting",
    captionKey: "projects.apps.hostingCaption",
    Icon: Server01,
    to: PROJECT_ROUTE.hosting,
    tone: "bg-chart-3/15 text-chart-3",
  },
  e2e: {
    labelKey: "projects.apps.e2e",
    captionKey: "projects.apps.e2eCaption",
    Icon: FlipBackward,
    to: PROJECT_ROUTE.e2e,
    tone: "bg-chart-4/15 text-chart-4",
  },
  analytics: {
    labelKey: "projects.apps.analytics",
    captionKey: "projects.apps.analyticsCaption",
    Icon: BarChartSquare02,
    to: PROJECT_ROUTE.analytics,
    tone: "bg-chart-5/15 text-chart-5",
  },
  cdn: {
    labelKey: "projects.apps.cdn",
    captionKey: "projects.apps.cdnCaption",
    Icon: Speedometer02,
    to: PROJECT_ROUTE.monitor,
    tone: "bg-chart-2/15 text-chart-2",
  },
  automations: {
    labelKey: "projects.apps.automations",
    captionKey: "projects.apps.automationsCaption",
    Icon: Zap,
    to: PROJECT_ROUTE.automations,
    tone: "bg-chart-4/15 text-chart-4",
  },
  experiments: {
    labelKey: "projects.apps.experiments",
    captionKey: "projects.apps.experimentsCaption",
    Icon: BezierCurve02,
    to: PROJECT_ROUTE.experiments,
    tone: "bg-chart-1/15 text-chart-1",
  },
};

/** Exported so the rail draws a recent app (`lib/recent-apps.ts`) with the same
 *  mark as the tile it was launched from. */
export const PROJECT_APPS = APPS;

/** Exported because the shell reads it to tell an app route from a place —
 *  see `hooks/use-app-takeover.ts`. */
export const LAUNCHABLE_VIEW_IDS = Object.keys(APPS) as LaunchableViewId[];

/** The apps this project offers, in the sidebar's own order. Pure and
 *  tested. */
export function launchableApps(project: {
  metadata?: {
    sidebarViews?: readonly string[] | null;
    sidebarViewsVersion?: number | null;
  } | null;
}): LaunchableViewId[] {
  const enabled = new Set(
    effectiveProjectSidebarViews(
      project.metadata?.sidebarViews as never,
      project.metadata?.sidebarViewsVersion,
    ),
  );
  return LAUNCHABLE_VIEW_IDS.filter((id) => enabled.has(id));
}

export function ProjectApps({
  project,
  orgSlug,
}: {
  project: VirtualMCPEntity;
  orgSlug: string;
}) {
  const t = useT();
  /** Site Editor opens a repo; without one the tile would bounce to
   *  Settings. */
  const hasSource = agentHasClonableSource(project.metadata);
  const apps = launchableApps(project).filter(
    (id) => id !== "site-editor" || hasSource,
  );
  if (apps.length === 0) return null;

  return (
    /* A quiet label for orientation; the tiles below already read as a group. */
    <section className="flex flex-col gap-2">
      {/* `pl-3` matches the Board/List/Feed tabs below: those are `sm`-size
          pill buttons with `px-3` built in, so their label sits 12px past the
          shared page edge. This heading has no button padding of its own, so
          it needs the same 12px to land on the same column. */}
      <h2 className="pl-3 text-muted-foreground text-sm font-medium">
        {t("projects.apps.heading")}
      </h2>
      <div className="flex flex-wrap gap-3">
        {apps.map((id) => {
          const app = APPS[id];
          return (
            <Link
              key={id}
              to={app.to}
              params={{ org: orgSlug, agentId: project.id }}
              /** The rail records the open, not the click — see
               *  `useRememberOpenApp`. */
              onClick={() => track("project_app_launched", { app: id })}
              title={t(app.captionKey)}
              className="group flex w-20 flex-col items-center gap-2 rounded-xl p-2 text-center transition-colors hover:bg-accent/50"
            >
              <span
                className={cn(
                  "relative flex size-14 shrink-0 items-center justify-center rounded-2xl transition-transform group-hover:scale-105",
                  app.tone,
                )}
              >
                <app.Icon size={24} />
              </span>
              <span className="w-full truncate text-foreground text-xs font-medium">
                {t(app.labelKey)}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
