/** The apps a project can launch, and the tile marks the rail and home draw. */

import {
  ClockRewind,
  BarChartSquare02,
  Beaker02,
  Calendar,
  CheckDone01,
  FileSearch02,
  Image01,
  LayoutAlt01,
  Server01,
  Speedometer02,
  Zap,
} from "@untitledui/icons";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { ProjectSidebarViewId } from "@/layouts/main-panel-tabs/project-sidebar-views";

/** Board and Overview are places, not apps. Reports is a separate
 *  destination and stays launchable. */
type LaunchableViewId = Exclude<ProjectSidebarViewId, "overview" | "board">;

/** `to` values are `PROJECT_ROUTE` literals, so a router rename fails to
 *  compile here. */
const APPS: Record<
  LaunchableViewId,
  {
    labelKey: TranslationKey;
    Icon: ComponentType<{ size?: number; className?: string }>;
    to: string;
    /** Tile tint: the app's own hue (`--app-*` in the design system). */
    tone: string;
  }
> = {
  reports: {
    labelKey: "projects.apps.reports",
    Icon: FileSearch02,
    to: PROJECT_ROUTE.reports,
    tone: "bg-app-reports/15 text-app-reports",
  },
  "site-editor": {
    labelKey: "projects.apps.siteEditor",
    Icon: LayoutAlt01,
    to: PROJECT_ROUTE.siteEditor,
    tone: "bg-app-site-editor/15 text-app-site-editor",
  },
  assets: {
    labelKey: "projects.apps.assets",
    Icon: Image01,
    to: PROJECT_ROUTE.assets,
    tone: "bg-app-assets/15 text-app-assets",
  },
  releases: {
    labelKey: "projects.apps.releases",
    Icon: ClockRewind,
    to: PROJECT_ROUTE.releases,
    tone: "bg-app-releases/15 text-app-releases",
  },
  hosting: {
    labelKey: "projects.apps.hosting",
    Icon: Server01,
    to: PROJECT_ROUTE.hosting,
    tone: "bg-app-hosting/15 text-app-hosting",
  },
  e2e: {
    labelKey: "projects.apps.e2e",
    Icon: CheckDone01,
    to: PROJECT_ROUTE.e2e,
    tone: "bg-app-e2e/15 text-app-e2e",
  },
  analytics: {
    labelKey: "projects.apps.analytics",
    Icon: BarChartSquare02,
    to: PROJECT_ROUTE.analytics,
    tone: "bg-app-analytics/15 text-app-analytics",
  },
  cdn: {
    labelKey: "projects.apps.cdn",
    Icon: Speedometer02,
    to: PROJECT_ROUTE.monitor,
    tone: "bg-app-cdn/15 text-app-cdn",
  },
  automations: {
    labelKey: "projects.apps.automations",
    Icon: Zap,
    to: PROJECT_ROUTE.automations,
    tone: "bg-app-automations/15 text-app-automations",
  },
  experiments: {
    labelKey: "projects.apps.experiments",
    Icon: Beaker02,
    to: PROJECT_ROUTE.experiments,
    tone: "bg-app-experiments/15 text-app-experiments",
  },
  calendar: {
    labelKey: "projects.apps.calendar",
    Icon: Calendar,
    to: PROJECT_ROUTE.calendar,
    tone: "bg-app-calendar/15 text-app-calendar",
  },
};

/** Exported so the rail draws a recent app (`lib/recent-apps.ts`) with the same
 *  mark as the tile it was launched from. */
export const PROJECT_APPS = APPS;

/** Exported because the shell reads it to tell an app route from a place —
 *  see `hooks/use-app-takeover.ts`. */
export const LAUNCHABLE_VIEW_IDS = Object.keys(APPS) as LaunchableViewId[];

/** The 56px app mark of a launcher tile. */
export const TILE_FACE =
  "size-14 justify-center rounded-2xl transition-transform group-hover:scale-105";

/** The apps card both homes show: a titled card of launcher tiles. */
export function AppsCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3 surface p-5", className)}>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <div className="grid min-w-0 grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:*:w-28">
        {children}
      </div>
    </section>
  );
}
