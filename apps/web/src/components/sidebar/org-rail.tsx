/** The always-visible org strip. Which orgs it draws is `railOrgs`; how one
 *  mark is drawn, labelled and marked as current is `RailItem`. */

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { EyeOff, Plus, Settings01, XClose } from "@untitledui/icons";
import { Link, useNavigate } from "@tanstack/react-router";
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
import { AgentAvatar } from "@/components/agent-icon";
import { OrgIcon } from "@/components/header/org-switcher";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { PROJECT_APPS } from "@/components/projects/project-apps";
import { useActiveOrganizations } from "@/lib/auth-client";
import { useAppTakeover } from "@/hooks/use-app-takeover";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import {
  useOpenApp,
  useRecentApps,
  useRememberOpenApp,
} from "@/hooks/use-recent-apps";
import { useRecentOrgs } from "@/hooks/use-recent-orgs";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { railOrgLimit, railOrgs } from "@/lib/recent-orgs";
import { OrgSearch } from "./org-search";
import { RailItem } from "./rail-item";
import type { RecentApp } from "@/lib/recent-apps";
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
  onOpenSettings,
  onHide,
}: {
  org: RailOrg;
  active: boolean;
  onSelect: () => void;
  onOpenSettings: () => void;
  /** Absent for the current org, which the rail always draws. */
  onHide?: () => void;
}) {
  const t = useT();
  return (
    <RailItem active={active}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={org.name}
                aria-current={active || undefined}
                onClick={active ? undefined : onSelect}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-xl focus-ring",
                  "transition-[opacity,transform] duration-150 ease-out",
                  active
                    ? "opacity-100"
                    : "cursor-pointer opacity-60 hover:scale-105 hover:opacity-100",
                )}
              >
                <OrgIcon org={org} size="lg" rounded="rounded-xl" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{org.name}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpenSettings}>
            <Settings01 />
            {t("sidebar.rail.organizationSettings")}
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
  );
}

/** The rail's mark for an entry: the catalogue's for a native app, the one
 *  picked in Settings › Views for a connection's app. Null for a retired id. */
function railAppFace(
  entry: RecentApp,
  orgSlug: string,
  t: ReturnType<typeof useT>,
): {
  label: string;
  link: { to: string; params: Record<string, string> };
  tone?: string;
  glyph: ReactNode;
} | null {
  const params = { org: orgSlug, agentId: entry.projectId };
  if (entry.connection) {
    const { label, icon, id, toolName } = entry.connection;
    return {
      label,
      link: {
        to: PROJECT_ROUTE.app,
        params: { ...params, connectionId: id, toolName },
      },
      glyph: (
        <AgentAvatar
          icon={icon}
          name={label}
          size="sm+"
          className="size-9 rounded-xl"
        />
      ),
    };
  }
  const app = PROJECT_APPS[entry.app as keyof typeof PROJECT_APPS];
  if (!app) return null;
  return {
    label: t(app.labelKey),
    link: { to: app.to, params },
    tone: app.tone,
    glyph: <app.Icon size={18} />,
  };
}

/** One app you had open, under the orgs. Labelled with the APP; the tooltip
 *  carries the project, since two projects can have the same app. */
function RailAppButton({
  entry,
  orgSlug,
  active,
  onClose,
}: {
  entry: RecentApp;
  orgSlug: string;
  active: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const face = railAppFace(entry, orgSlug, t);
  /** A retired app id: drop the row rather than draw a blank square. */
  if (!face) return null;

  return (
    <RailItem active={active} label={face.label}>
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={face.link.to}
              params={face.link.params}
              aria-label={`${face.label} · ${entry.projectTitle}`}
              aria-current={active || undefined}
              onClick={() => track("org_rail_recent_app_opened")}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl focus-ring",
                "transition-[opacity,transform] duration-150 ease-out",
                face.tone,
                active
                  ? "opacity-100"
                  : "opacity-60 hover:scale-105 hover:opacity-100",
              )}
            >
              {face.glyph}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">
            {face.label}
            <span className="text-muted-foreground">
              {" "}
              · {entry.projectTitle}
            </span>
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          aria-label={t("sidebar.rail.closeApp", { name: face.label })}
          onClick={() => {
            track("org_rail_recent_app_closed");
            onClose();
          }}
          className={cn(
            "absolute -top-1.5 -right-1.5 flex size-4 cursor-pointer items-center justify-center rounded-full",
            "bg-sidebar-accent text-muted-foreground ring-2 ring-sidebar hover:text-foreground",
            "opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 focus-visible:opacity-100 focus-visible:outline-none",
          )}
        >
          <XClose size={10} />
        </button>
      </div>
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

/** Mounted once by `Layout`, outside the resizable `<Sidebar>`, so collapse
 *  and resize never touch it. Desktop only — the mobile picker drawer already
 *  lists every org. */
export function OrgRail() {
  const t = useT();
  const navigate = useNavigate();
  const { org: currentOrg } = useProjectContext();
  const { data: organizations } = useActiveOrganizations();
  const [creatingOrg, setCreatingOrg] = useState(false);
  /** The border separates the rail from the SIDEBAR; a launched app takes the
   *  sidebar's place (`useAppTakeover`), leaving nothing to separate. */
  const takeover = useAppTakeover();
  const { recent, forget } = useRecentApps(currentOrg.slug);
  /** Which recent is the screen you are on, so the rail marks it the same way
   *  it marks the current org. */
  const openApp = useOpenApp();

  const orgs = (organizations ?? []) as RailOrg[];
  const { recent: recentOrgs, remember } = useRecentOrgs();
  /** Orgs the user took off the rail. They stay in search, and opening one
   *  from there puts it back. */
  const [storedHidden, setHidden] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.hiddenRailOrgs(),
    [],
  );
  const hiddenSlugs = Array.isArray(storedHidden) ? storedHidden : [];
  const orgLimit = useSyncExternalStore(
    subscribeToResize,
    orgLimitSnapshot,
    orgLimitServerSnapshot,
  );
  const { shown } = railOrgs(
    orgs.filter(
      (it) => it.slug === currentOrg.slug || !hiddenSlugs.includes(it.slug),
    ),
    recentOrgs,
    currentOrg.slug,
    orgLimit,
  );

  const travelTo = (slug: string) => {
    track("org_rail_travel");
    /** An org already on the rail keeps the rail as it is; one picked from
     *  search rolls the oldest off by recency, as before. */
    const onRail = shown.some((it) => it.slug === slug);
    setHidden((prev) =>
      (Array.isArray(prev) ? prev : []).filter((it) => it !== slug),
    );
    remember(slug, onRail ? shown.map((it) => it.slug) : undefined);
    navigate({ to: "/$org/home", params: { org: slug } });
  };

  return (
    <>
      <div
        /* `w-16` fits a one-word label like "Automations" inside the labels' padding; `pt-3` centres the first 36px mark on y=30, the line the org name and breadcrumb share. */
        className={cn(
          "flex w-16 shrink-0 flex-col items-center gap-1.5 overflow-y-auto bg-sidebar pt-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          !takeover && "border-r border-sidebar-border",
        )}
        aria-label={t("sidebar.rail.ariaLabel")}
      >
        {shown.map((candidate) => (
          <RailOrgButton
            key={candidate.id}
            org={candidate}
            active={candidate.slug === currentOrg.slug}
            onSelect={() => travelTo(candidate.slug)}
            onOpenSettings={() =>
              navigate({
                to: "/$org/settings",
                params: { org: candidate.slug },
              })
            }
            onHide={
              candidate.slug === currentOrg.slug
                ? undefined
                : () =>
                    setHidden((prev) => [
                      ...(Array.isArray(prev) ? prev : []),
                      candidate.slug,
                    ])
            }
          />
        ))}
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
                className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Plus size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("sidebar.picker.newOrganization")}
            </TooltipContent>
          </Tooltip>
        </RailItem>
        {recent.length > 0 && (
          <>
            {/* A rule and not a gap: below it the marks stop meaning "an org
                you belong to" and start meaning "a thing you had open", and
                nothing else in the rail says so. */}
            <span
              className="my-2 h-px w-6 shrink-0 bg-sidebar-border"
              aria-hidden
            />
            {recent.map((entry) => (
              <RailAppButton
                key={`${entry.app}:${entry.projectId}`}
                entry={entry}
                orgSlug={currentOrg.slug}
                active={
                  openApp?.app === entry.app &&
                  openApp.projectId === entry.projectId
                }
                onClose={() => forget(entry)}
              />
            ))}
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
