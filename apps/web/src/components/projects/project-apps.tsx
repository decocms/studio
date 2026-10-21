/**
 * The apps a project can launch. Which tiles appear comes from
 * `effectiveProjectSidebarViews`, the resolver the scoped sidebar uses, so the
 * two shapes cannot disagree about what a project has.
 */

import { Link } from "@tanstack/react-router";
import {
  ClockRewind,
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
import type { ComponentType, ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import {
  effectiveProjectSidebarViews,
  isProjectNativeViewId,
  resolveProjectSidebarViews,
  type ProjectNativeViewPresence,
  type ProjectSidebarViewId,
  type ProjectSidebarViewsMetadata,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import {
  keepAttachedPinnedViews,
  pinnedViewsOf,
} from "@/layouts/main-panel-tabs/attached-pinned-views";
import { useProjectNativeViewPresence } from "@/layouts/main-panel-tabs/use-project-native-view-presence";
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
    Icon: ComponentType<{ size?: number; className?: string }>;
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
  releases: {
    labelKey: "projects.apps.releases",
    captionKey: "projects.apps.releasesCaption",
    Icon: ClockRewind,
    to: PROJECT_ROUTE.releases,
    tone: "bg-chart-3/15 text-chart-3",
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
export function launchableApps(
  project: {
    metadata?:
      | (ProjectSidebarViewsMetadata & {
          sidebarViewsVersion?: number | null;
        })
      | null;
  },
  native?: ProjectNativeViewPresence,
): LaunchableViewId[] {
  const enabled = new Set(
    effectiveProjectSidebarViews(
      resolveProjectSidebarViews(project.metadata),
      project.metadata?.sidebarViewsVersion,
    ),
  );
  /** Native panels exist only where the project has their resource, as in the
   *  sidebar; a tile for one that is missing would open a dead end. */
  return LAUNCHABLE_VIEW_IDS.filter(
    (id) =>
      enabled.has(id) && (!native || !isProjectNativeViewId(id) || native[id]),
  );
}

/** One launcher tile. Native and pinned apps differ only in glyph and target. */
function AppTile({
  to,
  params,
  title,
  label,
  face,
  onClick,
}: {
  to: string;
  params: Record<string, string>;
  title?: string;
  label: string;
  /** The 56px mark; takes `group-hover` from the tile. */
  face: ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      to={to}
      params={params}
      onClick={onClick}
      title={title}
      className="group flex shrink-0 flex-col items-center gap-2.5 rounded-xl p-3 text-center transition-[background-color,transform] duration-150 ease-out hover:bg-accent/50 active:scale-[0.97]"
    >
      {face}
      <span className="flex w-full flex-col">
        {/* Two lines before an ellipsis: app names are phrases ("Funnel
            dashboard"), and one line cut most of them mid-word. */}
        <span className="line-clamp-2 break-words text-foreground text-xs font-medium">
          {label}
        </span>
      </span>
    </Link>
  );
}

/** The 56px app mark of a launcher tile. */
export const TILE_FACE =
  "size-14 justify-center rounded-2xl transition-transform group-hover:scale-105";

/** A component rather than a function because native presence is a
 *  per-project hook. */
interface ProjectAppTilesProps {
  project: VirtualMCPEntity;
  orgSlug: string;
}

/** Probes native presence only for a project that enabled a native app, so
 *  the org home does not fire a site-access check per project. */
function ProjectAppTiles(props: ProjectAppTilesProps) {
  const wantsNative = launchableApps(props.project).some(isProjectNativeViewId);
  return wantsNative ? (
    <ProjectAppTilesWithPresence {...props} />
  ) : (
    <ProjectAppTilesBody {...props} native={null} />
  );
}

function ProjectAppTilesWithPresence(props: ProjectAppTilesProps) {
  const native = useProjectNativeViewPresence(props.project);
  return <ProjectAppTilesBody {...props} native={native.presence} />;
}

function ProjectAppTilesBody({
  project,
  orgSlug,
  native,
}: ProjectAppTilesProps & {
  /** Null when the project enabled no native app, so none was probed. */
  native: ProjectNativeViewPresence | null;
}) {
  const t = useT();
  /** Site Editor opens a repo; without one the tile would bounce to
   *  Settings. */
  const hasSource = agentHasClonableSource(project.metadata);
  const apps = launchableApps(project, native ?? undefined).filter(
    (id) =>
      /* Both need a repo, as in the sidebar's presence rules. */
      (id !== "site-editor" && id !== "experiments" && id !== "releases") ||
      hasSource,
  );
  /** The project's pinned app views, the same ones the scoped sidebar lists. */
  const pinned = keepAttachedPinnedViews(
    pinnedViewsOf(project),
    (project.connections ?? []).map((c) => c.connection_id),
  ).filter((pv) => pv.toolName !== "fetch_assets");

  return (
    <>
      {apps.map((id) => {
        const app = APPS[id];
        return (
          <AppTile
            key={id}
            to={app.to}
            params={{ org: orgSlug, agentId: project.id }}
            /** The rail records the open, not the click — see
             *  `useRememberOpenApp`. */
            onClick={() => track("project_app_launched", { app: id })}
            title={t(app.captionKey)}
            label={t(app.labelKey)}
            face={
              <span className={cn(TILE_FACE, "flex items-center", app.tone)}>
                <app.Icon size={24} />
              </span>
            }
          />
        );
      })}
      {pinned.map((pv) => {
        const label = pv.label || pv.toolName;
        return (
          <AppTile
            key={`${pv.connectionId}:${pv.toolName}`}
            to={PROJECT_ROUTE.app}
            params={{
              org: orgSlug,
              agentId: project.id,
              connectionId: pv.connectionId,
              toolName: pv.toolName,
            }}
            onClick={() => track("project_app_launched", { app: "pinned" })}
            label={label}
            /** The icon and colour picked in Settings › Views; unpicked, the
             *  same name-derived mark that picker previews. */
            face={
              <AgentAvatar
                icon={pv.icon}
                name={label}
                size="md"
                className={TILE_FACE}
              />
            }
          />
        );
      })}
    </>
  );
}

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
    <section
      className={cn(
        "flex flex-col gap-3 rounded-2xl bg-card p-5 card-shadow",
        className,
      )}
    >
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <div className="grid min-w-0 grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:*:w-28">
        {children}
      </div>
    </section>
  );
}

/** Hidden until a tile lands: which apps a project has is only known once
 *  presence resolves. */
function AppsSection({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <section className="hidden flex-col gap-3 has-[a]:flex">
      {/* `pl-3` matches the Board/List/Feed tabs below, whose `sm` pills carry
          `px-3`. */}
      <h2 className="pl-3 text-muted-foreground text-sm font-medium">
        {t("projects.apps.heading")}
      </h2>
      <div className="flex min-w-0 flex-wrap gap-4 *:w-28">{children}</div>
    </section>
  );
}

export function ProjectApps({
  project,
  orgSlug,
}: {
  project: VirtualMCPEntity;
  orgSlug: string;
}) {
  return (
    <AppsSection>
      <ProjectAppTiles project={project} orgSlug={orgSlug} />
    </AppsSection>
  );
}
