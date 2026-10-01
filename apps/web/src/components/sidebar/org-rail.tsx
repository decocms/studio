/** The always-visible org strip. Which orgs it draws is `railOrgs`; how one
 *  mark is drawn, labelled and marked as current is `RailItem`. */

import { useState, useSyncExternalStore } from "react";
import { Plus } from "@untitledui/icons";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { OrgIcon } from "@/components/header/org-switcher";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { PROJECT_APPS } from "@/components/projects/project-apps";
import { useActiveOrganizations } from "@/lib/auth-client";
import { useAppTakeover } from "@/hooks/use-app-takeover";
import {
  useOpenApp,
  useRecentApps,
  useRememberOpenApp,
} from "@/hooks/use-recent-apps";
import { useRecentOrgs } from "@/hooks/use-recent-orgs";
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
}: {
  org: RailOrg;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <RailItem active={active}>
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
    </RailItem>
  );
}

/** One app you had open, under the orgs. Labelled with the APP; the tooltip
 *  carries the project, since two projects can have the same app. */
function RailAppButton({
  entry,
  orgSlug,
  active,
}: {
  entry: RecentApp;
  orgSlug: string;
  active: boolean;
}) {
  const t = useT();
  const app = PROJECT_APPS[entry.app as keyof typeof PROJECT_APPS];
  /** A retired app id: drop the row rather than draw a blank square. */
  if (!app) return null;

  return (
    <RailItem active={active} label={t(app.labelKey)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={app.to}
            params={{ org: orgSlug, agentId: entry.projectId }}
            aria-label={`${t(app.labelKey)} · ${entry.projectTitle}`}
            aria-current={active || undefined}
            onClick={() => track("org_rail_recent_app_opened")}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl focus-ring",
              "transition-[opacity,transform] duration-150 ease-out",
              app.tone,
              active
                ? "opacity-100"
                : "opacity-60 hover:scale-105 hover:opacity-100",
            )}
          >
            <app.Icon size={18} />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          {t(app.labelKey)}
          <span className="text-muted-foreground"> · {entry.projectTitle}</span>
        </TooltipContent>
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
  const { recent } = useRecentApps(currentOrg.slug);
  /** Which recent is the screen you are on, so the rail marks it the same way
   *  it marks the current org. */
  const openApp = useOpenApp();

  const orgs = (organizations ?? []) as RailOrg[];
  const { recent: recentOrgs, remember } = useRecentOrgs();
  const orgLimit = useSyncExternalStore(
    subscribeToResize,
    orgLimitSnapshot,
    orgLimitServerSnapshot,
  );
  const { shown, hidden } = railOrgs(
    orgs,
    recentOrgs,
    currentOrg.slug,
    orgLimit,
  );

  const travelTo = (slug: string) => {
    track("org_rail_travel");
    /** An org already on the rail keeps the rail as it is; one picked from
     *  search rolls the oldest off by recency, as before. */
    const onRail = shown.some((it) => it.slug === slug);
    remember(slug, onRail ? shown.map((it) => it.slug) : undefined);
    navigate({ to: "/$org/home", params: { org: slug } });
  };

  return (
    <>
      <div
        /* `w-18` fits the labels at two lines; `pt-3` centres the first 36px mark on y=30, the line the org name and breadcrumb share. */
        className={cn(
          "flex w-18 shrink-0 flex-col items-center gap-2 overflow-y-auto bg-sidebar pt-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
          />
        ))}
        {orgs.length > shown.length && (
          <OrgSearch
            orgs={orgs}
            currentSlug={currentOrg.slug}
            hiddenCount={hidden.length}
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
