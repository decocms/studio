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
}: {
  to: string;
  params: Record<string, string>;
  title?: string;
  label: string;
  caption?: string;
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
      className="group flex w-28 shrink-0 flex-col items-start gap-2.5 rounded-xl p-3 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-accent/50 active:scale-[0.97]"
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
function ProjectAppTiles({
  project,
  orgSlug,
  showProject,
}: {
  project: VirtualMCPEntity;
  orgSlug: string;
  showProject?: boolean;
}) {
  const t = useT();
  /** Site Editor opens a repo; without one the tile would bounce to
   *  Settings. */
  const hasSource = agentHasClonableSource(project.metadata);
  const native = useProjectNativeViewPresence(project);
  const apps = launchableApps(project, native.presence).filter(
    (id) =>
      (id !== "site-editor" || hasSource) &&
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
      const first = tiles[0];
      if (!first) return;
      const firstLine = tiles.filter(
        (tile) => tile.offsetTop === first.offsetTop,
      );
      setLine({
        overflows: firstLine.length < tiles.length,
        /* The tallest tile on the line: a two-line name is taller. */
        height: Math.max(...firstLine.map((tile) => tile.offsetHeight)),
      });
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
  const row = (
    <div className="flex gap-4">
      <div
        ref={oneLine ? lineRef : undefined}
        className={cn(
          "flex min-w-0 flex-1 flex-wrap gap-4",
          /* A tile's content sits inside its 12px hover padding. On a project
             that already matches the `pl-3` heading; in the card the pull
             lands it on the title's `px-5` column. */
          oneLine && "-ml-3",
          clipped && "overflow-hidden",
        )}
        style={
          clipped && line.height !== null
            ? { maxHeight: line.height }
            : undefined
        }
      >
        {children}
      </div>
      {oneLine && (line.overflows || expanded) && (
        /* Centred on the icons, not the labels: `mt-3` is the tile's own
           padding and `h-14` its face. Styled like the page's other "See"
           links so the same action reads the same everywhere. */
        <button
          type="button"
          className="mt-3 flex h-14 shrink-0 items-center self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setExpanded((it) => !it)}
        >
          {t(expanded ? "projects.apps.showLess" : "projects.apps.seeAll")}
        </button>
      )}
    </div>
  );

  /* On the org home the apps are one card among the brief's cards, drawn with
     `HomeCard`'s chrome. Not `HomeCard` itself: its body is a list of rows,
     and a tile row is not a list. */
  if (oneLine) {
    return (
      <section className="hidden flex-col overflow-hidden rounded-2xl bg-card card-shadow has-[a]:flex">
        <div className="flex h-12 items-center border-b border-border/70 px-5">
          <h2 className="text-[0.9rem] font-medium tracking-tight text-foreground">
            {title}
          </h2>
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

/** Every project's apps, on the org home. Each tile names its project. */
export function OrgApps({
  projects,
  orgSlug,
}: {
  projects: VirtualMCPEntity[];
  orgSlug: string;
}) {
  return (
    <AppsSection oneLine>
      {projects.map((project) => (
        <ProjectAppTiles
          key={project.id}
          project={project}
          orgSlug={orgSlug}
          showProject
        />
      ))}
    </AppsSection>
  );
}
