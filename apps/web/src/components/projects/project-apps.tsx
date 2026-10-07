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
import { useState, type ComponentType, type ReactNode } from "react";
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
import { appOpenKey } from "@/lib/recent-apps";

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

/** One launcher tile. Native and pinned apps differ only in glyph and target;
 *  `caption` names the project where tiles from several share a row. */
function AppTile({
  to,
  params,
  title,
  label,
  caption,
  face,
  onClick,
  order,
}: {
  to: string;
  params: Record<string, string>;
  title?: string;
  label: string;
  caption?: string;
  /** The 56px mark; takes `group-hover` from the tile. */
  face: ReactNode;
  onClick: () => void;
  /** Flex `order`, so tiles from separate projects can interleave by
   *  recency without leaving their project's component. */
  order?: number;
}) {
  return (
    <Link
      to={to}
      params={params}
      onClick={onClick}
      title={title}
      style={order === undefined ? undefined : { order }}
      className="group flex shrink-0 flex-col items-center gap-2.5 rounded-xl p-3 text-center transition-[background-color,transform] duration-150 ease-out hover:bg-accent/50 active:scale-[0.97]"
    >
      {face}
      <span className="flex w-full flex-col">
        {/* Two lines before an ellipsis: app names are phrases ("Funnel
            dashboard"), and one line cut most of them mid-word. */}
        <span className="line-clamp-2 break-words text-foreground text-xs font-medium">
          {label}
        </span>
        {caption && (
          <span className="truncate text-muted-foreground text-xs">
            {caption}
          </span>
        )}
      </span>
    </Link>
  );
}

const TILE_FACE =
  "size-14 justify-center rounded-2xl transition-transform group-hover:scale-105";

const ORG_HIDDEN_APPS = new Set<LaunchableViewId>(["reports", "site-editor"]);

/** A project's tiles, bare, so the org home can lay several projects' tiles
 *  in one row. A component rather than a function because native presence is
 *  a per-project hook. */
interface ProjectAppTilesProps {
  project: VirtualMCPEntity;
  orgSlug: string;
  showProject?: boolean;
  /** Position of an `appOpenKey` in the org's history, when ordering by it. */
  rank?: (key: string) => number;
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
  showProject,
  rank,
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
      ((id !== "site-editor" && id !== "experiments" && id !== "releases") ||
        hasSource) &&
      /* Every project has these two, so across an org they bury the apps
         someone actually chose. They stay on each project's own screen. */
      !(showProject && ORG_HIDDEN_APPS.has(id)),
  );
  /** The project's pinned app views, the same ones the scoped sidebar lists. */
  const pinned = keepAttachedPinnedViews(
    pinnedViewsOf(project),
    (project.connections ?? []).map((c) => c.connection_id),
  ).filter((pv) => pv.toolName !== "fetch_assets");
  const caption = showProject ? project.title : undefined;

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
            caption={caption}
            order={rank?.(appOpenKey(project.id, id))}
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
            caption={caption}
            order={rank?.(
              appOpenKey(project.id, `app:${pv.connectionId}:${pv.toolName}`),
            )}
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

/** Whether a wrapping row spilled past its first line, and that line's
 *  height. Tiles land per project as presence resolves, so it re-reads when
 *  children change, not only on resize. A callback ref: `useEffect` is banned
 *  here. */
function useFirstLine(): readonly [
  { overflows: boolean; height: number | null },
  (node: HTMLElement | null) => void | (() => void),
] {
  const [line, setLine] = useState<{
    overflows: boolean;
    height: number | null;
  }>({ overflows: false, height: null });

  const ref = (node: HTMLElement | null) => {
    if (!node) return;
    const measure = () => {
      const tiles = [...node.children] as HTMLElement[];
      if (tiles.length === 0) return;
      /* By position, not DOM order: `order` reshuffles the tiles. */
      const top = Math.min(...tiles.map((tile) => tile.offsetTop));
      const firstLine = tiles.filter((tile) => tile.offsetTop === top);
      const overflows = firstLine.length < tiles.length;
      /* The tallest tile on the line: a two-line name is taller. */
      const height = Math.max(...firstLine.map((tile) => tile.offsetHeight));
      /* The ref re-attaches each render; a fresh object would loop. */
      setLine((prev) =>
        prev.overflows === overflows && prev.height === height
          ? prev
          : { overflows, height },
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    const mutation = new MutationObserver(measure);
    mutation.observe(node, { childList: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  };

  return [line, ref] as const;
}

/** The heading and tile row. Hidden until a tile lands: which projects have
 *  apps is only known once each one's presence resolves. `oneLine` clips to
 *  the first line and ends it with See all, for a page where apps are one
 *  block among many. */
function AppsSection({
  children,
  oneLine,
}: {
  children: ReactNode;
  oneLine?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [line, lineRef] = useFirstLine();
  const clipped = oneLine && !expanded;

  const title = t("projects.apps.heading");
  /* In the card's header, where the page's other cards keep their "See"
     links, styled the same so the same action reads the same everywhere. */
  const seeAll = (line.overflows || expanded) && (
    <button
      type="button"
      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
      onClick={() => setExpanded((it) => !it)}
    >
      {t(expanded ? "projects.apps.showLess" : "projects.apps.seeAll")}
    </button>
  );
  const row = (
    <div
      ref={oneLine ? lineRef : undefined}
      className={cn(
        /* In the card, a grid whose columns stretch to share the width, so
           the line ends on the card's edge instead of a ragged gap; the pull
           on both sides lets the tiles' 12px hover padding reach the card's
           `px-5` on each edge. On a project, fixed tiles that wrap, starting
           on the `pl-3` heading. */
        oneLine
          ? "-mx-3 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-2 gap-y-4"
          : "flex flex-wrap gap-4 *:w-28",
        "min-w-0",
        clipped && "overflow-hidden",
      )}
      style={
        clipped && line.height !== null ? { maxHeight: line.height } : undefined
      }
    >
      {children}
    </div>
  );

  /* On the org home the apps are one card among the brief's cards, drawn with
     `HomeCard`'s chrome. Not `HomeCard` itself: its body is a list of rows,
     and a tile row is not a list. */
  if (oneLine) {
    return (
      <section className="hidden flex-col overflow-hidden rounded-2xl bg-card card-shadow has-[a]:flex">
        <div className="flex h-12 items-center justify-between gap-3 border-b border-border/70 px-5">
          <h2 className="text-[0.9rem] font-medium tracking-tight text-foreground">
            {title}
          </h2>
          {seeAll}
        </div>
        <div className="px-5 py-3">{row}</div>
      </section>
    );
  }

  return (
    /* A quiet label for orientation; the tiles below already read as a group. */
    <section className="hidden flex-col gap-3 has-[a]:flex">
      {/* `pl-3` matches the Board/List/Feed tabs below, whose `sm` pills carry
          `px-3`. */}
      <h2 className="pl-3 text-muted-foreground text-sm font-medium">
        {title}
      </h2>
      {row}
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

/** Every project's apps, on the org home, most recently opened first. Each
 *  tile names its project. */
export function OrgApps({
  projects,
  orgSlug,
  opens,
}: {
  projects: VirtualMCPEntity[];
  orgSlug: string;
  /** The org's app history, newest first — `useAppOpens`. Passed in because
   *  that hook reads this module's catalogue. */
  opens: readonly string[];
}) {
  const position = new Map(opens.map((key, i) => [key, i]));
  /** Never-opened apps keep their project order, after every opened one. */
  const rank = (key: string) => position.get(key) ?? opens.length;
  return (
    <AppsSection oneLine>
      {projects.map((project) => (
        <ProjectAppTiles
          key={project.id}
          project={project}
          orgSlug={orgSlug}
          showProject
          rank={rank}
        />
      ))}
    </AppsSection>
  );
}
