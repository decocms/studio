/** The always-visible org strip. Which orgs it draws is `railOrgs`. */

import { type ReactNode, useState } from "react";
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
import { railOrgs } from "@/lib/recent-orgs";
import { OrgSearch } from "./org-search";
import type { RecentApp } from "@/lib/recent-apps";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

interface RailOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

/**
 * The rail's one selection signal, shared by orgs and apps.
 *
 * A pill on the rail's left edge rather than a ring around the mark: a ring
 * has to sit OUTSIDE the icon, so it competes with the icon's own shape and
 * needs an offset colour that only works against one background. The pill
 * lives in the gutter, is the same for a square org logo and a tinted app
 * glyph, and can grow out of its hover state instead of appearing from
 * nowhere — which is the whole reason Discord's rail reads at a glance.
 */
function RailItem({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div className="group/rail relative flex w-full shrink-0 justify-center">
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground",
          "transition-[height,opacity] duration-200 ease-[var(--ease-out-cubic)]",
          "motion-reduce:transition-none",
          active
            ? "h-7 opacity-100"
            : "h-2 opacity-0 group-hover/rail:opacity-60",
        )}
      />
      {children}
    </div>
  );
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

/**
 * One app you had open, under the orgs.
 *
 * It wears the launcher's own glyph and tint so the icon here and the tile it
 * came from read as the same door. The tooltip names the project as well as the
 * app, because two projects can have the same app and the mark alone cannot say
 * which one this is.
 */
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
  /** An id no launcher offers any more — a retired app, or a value from an
   *  older build. Drawing a blank square is worse than dropping the row. */
  if (!app) return null;

  return (
    <RailItem active={active}>
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

/** Mounted once by `Layout`, outside the resizable `<Sidebar>` — a fixed
 *  column the sidebar's own collapse/resize never touches. Desktop only: the
 *  mobile sheet already lists every org through the picker drawer, and a
 *  second rail would just eat width from a screen that has none to spare. */
export function OrgRail() {
  const t = useT();
  const navigate = useNavigate();
  const { org: currentOrg } = useProjectContext();
  const { data: organizations } = useActiveOrganizations();
  const [creatingOrg, setCreatingOrg] = useState(false);
  /** The border separates the rail from the SIDEBAR beside it. A launched app
   *  takes the sidebar's place (`useAppTakeover`), so with no sidebar there the
   *  line just sits against the app's own content — the rail's stub of a
   *  sidebar that never fully left. */
  const takeover = useAppTakeover();
  const { recent } = useRecentApps(currentOrg.slug);
  /** The rail is where "take me back to the thing I was in" lives, so it is
   *  also what records having been there — by URL as much as by launcher. */
  useRememberOpenApp(currentOrg.slug);
  /** Which recent is the screen you are on, so the rail marks it the same way
   *  it marks the current org. */
  const openApp = useOpenApp();

  const orgs = (organizations ?? []) as RailOrg[];
  const { recent: recentOrgs, remember } = useRecentOrgs();
  const { shown, hidden } = railOrgs(orgs, recentOrgs, currentOrg.slug);

  const travelTo = (slug: string) => {
    track("org_rail_travel");
    remember(slug);
    navigate({ to: "/$org/home", params: { org: slug } });
  };

  return (
    <>
      <div
        /* `pt-3` and not `pt-2`: the first org mark is 36px, so 12px of inset
          centres it on y=30 — the line the sidebar's org name and the panel's
          breadcrumb already share. At 8px it sat 4px high, which reads as the
          whole rail being off rather than as one row being. */
        className={cn(
          "flex w-14 shrink-0 flex-col items-center gap-2.5 overflow-y-auto bg-sidebar pt-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
        {recent.length > 0 && (
          <>
            {/* A rule and not a gap: below it the marks stop meaning "an org
                you belong to" and start meaning "a thing you had open", and
                nothing else in the rail says so. */}
            <span
              className="my-1 h-px w-6 shrink-0 bg-sidebar-border"
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
