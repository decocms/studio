/** The always-visible org strip. Which orgs it draws is `railOrgs`; how one
 *  mark is drawn, labelled and marked as current is `RailItem`. */

import { Fragment, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EyeOff, Pin01, Plus, Settings01, XClose } from "@untitledui/icons";
import {
  Link,
  useMatchRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@decocms/ui/components/context-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar, agentIconColor } from "@/components/agent-icon";
import { OrgIcon } from "@/components/header/org-switcher";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { PROJECT_APPS } from "@/components/projects/project-apps";
import { useActiveOrganizations } from "@/lib/auth-client";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useOpenApp, useRememberOpenApp } from "@/hooks/use-recent-apps";
import { useRecentProjects } from "@/hooks/use-recent-projects";
import { useProjectScope, useScopeId } from "@/hooks/use-project-scope";
import { useRecentOrgs } from "@/hooks/use-recent-orgs";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { railOrgLimit, railOrgs, withCurrentOrg } from "@/lib/recent-orgs";
import {
  EMPTY_RAIL_ORG_PREFS,
  arrangeRailOrgs,
  hideRailOrg,
  moveRailOrg,
  readRailOrgPrefs,
  showRailOrg,
  toggleRailOrgPin,
  type RailOrgPrefs,
} from "@/lib/rail-org-prefs";
import { OrgSearch } from "./org-search";
import { RailItem } from "./rail-item";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

/** The window's height is external mutable state, so it is read through
 *  `useSyncExternalStore` (as `useIsMobile` reads its width). The snapshot is
 *  the derived count, so a resize that keeps it re-renders nothing. */
function subscribeToResize(onChange: () => void): () => void {
  globalThis.addEventListener("resize", onChange);
  return () => globalThis.removeEventListener("resize", onChange);
}
const orgLimitSnapshot = () => railOrgLimit(globalThis.innerHeight);
const orgLimitServerSnapshot = () => railOrgLimit(0);

interface RailOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

function RailOrgButton({
  org,
  active,
  onSelect,
  pinned,
  onOpenSettings,
  onTogglePin,
  onHide,
}: {
  org: RailOrg;
  active: boolean;
  pinned: boolean;
  /** Absent for the org you are already at the top of. */
  onSelect?: () => void;
  onOpenSettings: () => void;
  onTogglePin: () => void;
  /** Absent for the current org, which the rail always draws. */
  onHide?: () => void;
}) {
  const t = useT();
  /** Dragging starts after 8px of travel (the sensor's), so a click still
   *  selects. Only the pointer: the sortable's keyboard attributes would add
   *  a second tab stop to every mark. */
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: org.slug });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(
          transform ? { ...transform, x: 0 } : null,
        ),
        transition,
        zIndex: isDragging ? 1 : undefined,
        viewTransitionName: `rail-org-${org.slug}`,
      }}
      className="w-full shrink-0 touch-none"
    >
      <RailItem active={active}>
        <ContextMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={org.name}
                  aria-current={active || undefined}
                  onClick={onSelect}
                  className={cn(
                    "relative flex shrink-0 items-center justify-center rounded-xl focus-ring",
                    "transition-[opacity,transform] duration-150 ease-out",
                    active
                      ? "opacity-100"
                      : "opacity-60 hover:scale-105 hover:opacity-100",
                    onSelect && "cursor-pointer",
                  )}
                >
                  <OrgIcon org={org} size="lg" />
                  {pinned && (
                    <span
                      aria-hidden
                      className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-sidebar-accent text-muted-foreground ring-2 ring-sidebar"
                    >
                      <Pin01 size={9} />
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">{org.name}</TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onOpenSettings}>
              <Settings01 />
              {t("sidebar.rail.organizationSettings")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onTogglePin}>
              <Pin01 />
              {pinned
                ? t("sidebar.rail.unpinOrganization")
                : t("sidebar.rail.pinOrganization")}
            </ContextMenuItem>
            {onHide && (
              <ContextMenuItem onSelect={onHide}>
                <EyeOff />
                {t("sidebar.rail.hideOrganization")}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </RailItem>
    </div>
  );
}

/** A project you opened in this org, inside the org's group: its tile and
 *  name, the one you are in outlined in its own colour. */
function RailProjectButton({
  project,
  orgSlug,
  active,
  onClose,
  onNavigate,
}: {
  project: { id: string; title: string; icon?: string | null };
  orgSlug: string;
  active: boolean;
  onClose: () => void;
  onNavigate?: () => void;
}) {
  const t = useT();
  const tint = agentIconColor(project.icon, project.title);
  return (
    <div className="group/rail relative flex w-full flex-col items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={PROJECT_ROUTE.root}
            params={{ org: orgSlug, agentId: project.id }}
            aria-label={project.title}
            aria-current={active || undefined}
            onClick={() => {
              track("org_rail_recent_project_opened");
              onNavigate?.();
            }}
            className={cn(
              "flex shrink-0 rounded-lg focus-ring",
              tint.text,
              active && "ring-[1.5px] ring-current",
            )}
          >
            <AgentAvatar
              icon={project.icon}
              name={project.title}
              size="sm"
              className="size-8 rounded-lg"
            />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{project.title}</TooltipContent>
      </Tooltip>
      <span
        aria-hidden
        className={cn(
          "line-clamp-2 w-full text-center text-2xs break-words transition-colors",
          active
            ? "font-medium text-sidebar-foreground"
            : "text-muted-foreground group-hover/rail:text-sidebar-foreground",
        )}
      >
        {project.title}
      </span>
      <button
        type="button"
        aria-label={t("sidebar.rail.closeApp", { name: project.title })}
        onClick={() => {
          track("org_rail_recent_project_closed");
          onClose();
        }}
        className={cn(
          "absolute -top-1.5 right-[calc(50%-1.25rem)] flex size-4 cursor-pointer items-center justify-center rounded-full",
          "bg-sidebar-accent text-muted-foreground ring-2 ring-sidebar hover:text-foreground",
          "opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 focus-visible:opacity-100 focus-visible:outline-none",
        )}
      >
        <XClose size={10} />
      </button>
    </div>
  );
}

/** Where an app opens outside any org and project — only the Site Editor,
 *  over the `deco serve` on this machine. */
const LOCAL_APP_ROUTES: Partial<Record<string, string>> = {
  "site-editor": "/site-editor",
};

/** The app open outside any org (`/site-editor`): marked as the screen you
 *  are on, like a recent app, but never recorded — there is no org to keep
 *  it in. */
function RailLocalAppButton({ app: appId }: { app: string }) {
  const t = useT();
  const app = PROJECT_APPS[appId as keyof typeof PROJECT_APPS];
  const to = LOCAL_APP_ROUTES[appId];
  if (!app || !to) return null;

  return (
    <RailItem active label={t(app.labelKey)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={to}
            aria-label={t(app.labelKey)}
            aria-current="page"
            data-testid="org-rail-local-app"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl focus-ring opacity-100",
              app.tone,
            )}
          >
            <app.Icon size={18} />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{t(app.labelKey)}</TooltipContent>
      </Tooltip>
    </RailItem>
  );
}

/** Records the app the route is on, by URL as much as by launcher. Mounted
 *  by `Layout` beside the rail but on every viewport, since the org home's
 *  app order reads this history on mobile too. */
export function OpenAppRecorder() {
  const { org } = useProjectContext();
  useRememberOpenApp(org.slug);
  return null;
}

/** Mounted by `Layout` outside the resizable `<Sidebar>`; `onNavigate` closes the mobile sheet. */
export function OrgRail({ onNavigate }: { onNavigate?: () => void } = {}) {
  const t = useT();
  const navigate = useNavigate();
  const { org: currentOrg } = useProjectContext();
  /** A switch keeps the current org painted until the next one has loaded
   *  (the `$org` route's loader), so the rail marks where you are going from
   *  the click on — otherwise a slow org reads as a click that did nothing. */
  const matchRoute = useMatchRoute();
  const loading = useRouterState({ select: (s) => s.isLoading });
  const travelling = loading
    ? matchRoute({ to: "/$org", fuzzy: true, pending: true })
    : false;
  const activeSlug = travelling ? travelling.org : currentOrg.slug;
  const { data: organizations } = useActiveOrganizations();
  const [creatingOrg, setCreatingOrg] = useState(false);
  /** The border separates the rail from the sidebar; collapsed, there is none. */
  const collapsed = useSidebarCollapsed();
  /** The projects you opened here, under the org's mark, newest first. */
  const { recent: recentIds, forget } = useRecentProjects(currentOrg.slug);
  const { projects } = useProjectScope();
  const scopeId = useScopeId();
  const openApp = useOpenApp();
  /** Outside any org there are no recents, only the app on screen. */
  const localApp = openApp && openApp.projectId === null ? openApp.app : null;
  const recentProjects = localApp
    ? []
    : recentIds.flatMap((id) => projects.filter((p) => p.id === id));

  const orgs = withCurrentOrg((organizations ?? []) as RailOrg[], currentOrg);
  const { recent: recentOrgs, remember } = useRecentOrgs();
  /** Hidden, pinned and dragged order. Hidden orgs stay in search, and
   *  opening one from there puts it back. */
  const [storedPrefs, setPrefs] = useLocalStorage<RailOrgPrefs>(
    LOCALSTORAGE_KEYS.railOrgPrefs(),
    EMPTY_RAIL_ORG_PREFS,
  );
  const prefs = readRailOrgPrefs(storedPrefs);
  const orgLimit = useSyncExternalStore(
    subscribeToResize,
    orgLimitSnapshot,
    orgLimitServerSnapshot,
  );
  const { shown } = railOrgs(
    arrangeRailOrgs(orgs, prefs, currentOrg.slug),
    recentOrgs,
    currentOrg.slug,
    orgLimit,
    prefs.pinned,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    track("org_rail_reordered");
    setPrefs((prev) =>
      moveRailOrg(
        readRailOrgPrefs(prev),
        shown.map((it) => it.slug),
        String(active.id),
        String(over.id),
      ),
    );
  };

  /** A view transition, so the marks slide to their new places instead of jumping. */
  const goHome = (slug: string) => {
    onNavigate?.();
    navigate({ to: "/$org/home", params: { org: slug }, viewTransition: true });
  };

  const travelTo = (slug: string) => {
    track("org_rail_travel");
    /** An org already on the rail keeps the rail as it is; one picked from
     *  search rolls the oldest off by recency, as before. */
    const onRail = shown.some((it) => it.slug === slug);
    setPrefs((prev) => showRailOrg(readRailOrgPrefs(prev), slug));
    remember(slug, onRail ? shown.map((it) => it.slug) : undefined);
    goHome(slug);
  };

  return (
    <>
      <div
        /* The Figma rail: 68px wide, 10px between marks; `pt-3` keeps the first mark on the line the org name and breadcrumb share. */
        className={cn(
          "flex w-[68px] shrink-0 flex-col items-center gap-2.5 overflow-y-auto bg-sidebar px-2.5 pt-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          !collapsed && "border-r border-sidebar-border",
        )}
        aria-label={t("sidebar.rail.ariaLabel")}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={shown.map((it) => it.slug)}
            strategy={verticalListSortingStrategy}
          >
            {shown.map((candidate) => (
              <Fragment key={candidate.id}>
                <RailOrgButton
                  org={candidate}
                  active={candidate.slug === activeSlug}
                  pinned={prefs.pinned.includes(candidate.slug)}
                  onSelect={
                    candidate.slug !== currentOrg.slug
                      ? () => travelTo(candidate.slug)
                      : scopeId
                        ? () => goHome(candidate.slug)
                        : undefined
                  }
                  onOpenSettings={() => {
                    onNavigate?.();
                    navigate({
                      to: "/$org/settings",
                      params: { org: candidate.slug },
                    });
                  }}
                  onTogglePin={() =>
                    setPrefs((prev) =>
                      toggleRailOrgPin(readRailOrgPrefs(prev), candidate.slug),
                    )
                  }
                  onHide={
                    candidate.slug === currentOrg.slug
                      ? undefined
                      : () =>
                          setPrefs((prev) =>
                            hideRailOrg(readRailOrgPrefs(prev), candidate.slug),
                          )
                  }
                />
                {candidate.slug === currentOrg.slug &&
                  recentProjects.length > 0 && (
                    <div
                      style={{ viewTransitionName: "rail-projects" }}
                      className="-mx-1.5 flex w-[calc(100%+0.75rem)] flex-col items-center gap-3 rounded-[12px] bg-foreground/4 px-1 py-3"
                    >
                      {recentProjects.map((project) => (
                        <RailProjectButton
                          key={project.id}
                          project={project}
                          orgSlug={currentOrg.slug}
                          active={scopeId === project.id}
                          onClose={() => forget(project.id)}
                          onNavigate={onNavigate}
                        />
                      ))}
                    </div>
                  )}
              </Fragment>
            ))}
          </SortableContext>
        </DndContext>
        {orgs.length > shown.length && (
          <OrgSearch
            orgs={orgs}
            currentSlug={currentOrg.slug}
            hiddenCount={orgs.length - shown.length}
            onSelect={travelTo}
          />
        )}
        <RailItem active={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("sidebar.picker.newOrganization")}
                onClick={() => setCreatingOrg(true)}
                className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-ring"
              >
                <Plus size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("sidebar.picker.newOrganization")}
            </TooltipContent>
          </Tooltip>
        </RailItem>
        {localApp && (
          <>
            {/* A rule and not a gap: below it the mark stops meaning "an org
                you belong to" and starts meaning "a thing you had open". */}
            <span
              className="my-2 h-px w-6 shrink-0 bg-sidebar-border"
              aria-hidden
            />
            <RailLocalAppButton app={localApp} />
          </>
        )}
      </div>
      <CreateOrganizationDialog
        open={creatingOrg}
        onOpenChange={setCreatingOrg}
      />
    </>
  );
}
