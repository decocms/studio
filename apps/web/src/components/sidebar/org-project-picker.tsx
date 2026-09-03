/** The one sidebar picker: organizations and projects in a single list. It
 *  merges two controls that were never the same kind of thing, so the design is
 *  about keeping them apart — picking a PROJECT writes `?virtualmcpid=` and
 *  stays put, while picking an ORGANIZATION changes the path, remounts the
 *  shell and drops the scope. A footer strip names the verb for the focused row
 *  before Enter commits it, since those two live one arrow-key apart, and
 *  nothing is ever auto-selected: a scope nobody chose silently shortens lists.
 *  Two modes, deliberately not one — BROWSING (no term) lists this org's
 *  projects then the other orgs by logo and name, each of which TRAVELS, since
 *  another org's projects are not this org's to show; SEARCHING (a term) asks
 *  one cross-org endpoint, so it never mixes a server-filtered population with
 *  an unfiltered one and is how you reach another org's project by name. */

import { useDeferredValue, useId, useState } from "react";
import { Check, ChevronSelectorVertical, Plus } from "@untitledui/icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { SidebarMenuButton } from "@decocms/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { INSET_FOCUS_RING } from "@decocms/ui/lib/focus-ring.ts";
import { useNavigate } from "@tanstack/react-router";
import { AgentAvatar } from "@/components/agent-icon";
import { ProjectIcon } from "@/components/project-icon";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { InvitationRow, OrgIcon } from "@/components/header/org-switcher";
import { usePendingInvitations } from "@/hooks/use-pending-invitations";
import { useActiveOrganizations } from "@/lib/auth-client";
import {
  type ProjectSearchHit,
  useProjectSearch,
} from "@/hooks/use-project-search";
import { useLeafRoutePath } from "@/hooks/use-destination-route";
import { useProjectScope } from "@/hooks/use-project-scope";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useProjectContext, useVirtualMCPsPage } from "@/sdk";

/** The fields the picker needs off an organization row. */
interface PickerOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

/** What Enter does for the focused row. The strip reads this, so a row that
 *  forgets to declare its kind cannot silently claim the wrong verb. */
type RowKind = "scope" | "travel";

interface RowMeta {
  kind: RowKind;
  /** The org or project the verb names. */
  label: string;
  /** Set when leaving the current org — the strip says so. */
  leaves?: string;
}

/** A group heading with the create affordance for that group on its right.
 *
 *  Creation belongs beside the thing it creates: "+" next to Organizations
 *  makes an organization, "+" next to this org's projects makes a project. It
 *  is a real button rather than a list row, so it never competes with the rows
 *  for the highlight or for Enter.
 *
 *  Rendered as a SIBLING of its `CommandGroup`, never through cmdk's `heading`
 *  prop: cmdk puts that node inside `aria-hidden={true}` unconditionally, which
 *  pruned these buttons from the accessibility tree while leaving them in the
 *  tab order — and they are the only "New organization" and "New project"
 *  controls in the shell. The group is named through `aria-labelledby` instead,
 *  which works on a visible element. */
function GroupHeading({
  id,
  label,
  createLabel,
  onCreate,
}: {
  id: string;
  label: string;
  createLabel: string;
  onCreate: () => void;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-xs font-medium text-muted-foreground">
      <span id={id} className="truncate">
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={createLabel}
            className="-my-1 shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={onCreate}
          >
            <Plus size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{createLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** One height for every row. Projects and organizations are both a mark, a
 *  name and a trailing note now, so nothing in the list can step out of line
 *  with anything else. */
const ROW = "min-h-9 items-center";

/** Structured, exact values: the strip looks the focused row up by identity
 *  rather than parsing its label back out. */
const rowValue = {
  allProjects: "scope:__all__",
  project: (id: string) => `scope:${id}`,
  org: (slug: string) => `org:${slug}`,
  foreignProject: (slug: string, id: string) => `travel:${slug}:${id}`,
} as const;

/** The warning strip, for the one row whose Enter does something you cannot see
 *  coming: leaving the organization you are in. Scoping a project is visible in
 *  the row itself and needs no narration — a strip that spoke for every row put
 *  a line of prose under a list of nine words and made the safe case look as
 *  consequential as the unsafe one. */
function VerbStrip({
  active,
  rows,
}: {
  active: string;
  rows: Map<string, RowMeta>;
}) {
  const t = useT();
  const meta = rows.get(active);

  if (meta?.kind !== "travel") return null;

  return (
    <div className="border-t border-border px-3 py-2 text-xs text-warning">
      {t("sidebar.picker.verbTravel", { name: meta.label })}
      {meta.leaves && (
        <span className="text-muted-foreground">
          {" "}
          {t("sidebar.picker.verbLeaves", { name: meta.leaves })}
        </span>
      )}
    </div>
  );
}

function PickerContent({
  onClose,
  onCreateOrg,
}: {
  onClose: () => void;
  onCreateOrg: () => void;
}) {
  const t = useT();
  /** Stable ids so each group can be named by its VISIBLE header — see
   *  `GroupHeading` on why the header cannot live in cmdk's `heading`. */
  const projectsHeadingId = useId();
  const orgsHeadingId = useId();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { scopeId, projects, setScope } = useProjectScope();
  /** Shares the scope hook's query key, so this is the same request. */
  const { hasMore } = useVirtualMCPsPage();

  const [search, setSearch] = useState("");
  const [active, setActive] = useState<string>(rowValue.allProjects);

  const deferred = useDeferredValue(search);
  const term = deferred.trim();
  const searching = term.length > 0;

  const { data: organizations } = useActiveOrganizations();
  const { invitations, refetch: refetchInvitations } = usePendingInvitations();
  /** EVERY org, the current one included and listed first.
   *
   *  It used to be filtered out, which left a single-org user with an empty
   *  Organizations group — and since the group's heading carries the only
   *  "New organization" control in the product, the one person who most
   *  needed to create a second org was the one person who could not. Listing
   *  the current org keeps the group non-empty for everyone, and it reads
   *  better besides: the list now answers "which orgs am I in", not "which
   *  orgs am I not looking at". */
  const allOrgs = ((organizations ?? []) as PickerOrg[])
    .slice()
    .sort((a, b) => (a.slug === org.slug ? -1 : b.slug === org.slug ? 1 : 0));

  const { hits, isSearching, isStale, isError } = useProjectSearch(
    searching ? term : "",
  );
  /** The settings tree is its own shell; the scope means nothing inside it. */
  const inSettings = useLeafRoutePath().startsWith("/$org/settings");

  const rows = new Map<string, RowMeta>();

  /** Picking a project from the SETTINGS tree has to leave it. `setScope`
   *  writes the param onto the current route, which in settings means landing
   *  on `/$org/settings/...?virtualmcpid=` — a settings page wearing a scope
   *  nothing there reads. The picker is the one scope control reachable from
   *  inside settings, so this is where that has to be answered. */
  const scopeTo = (id: string | null) => {
    track("scope_set", { scoped: id !== null, fromSettings: inSettings });
    if (inSettings) {
      navigate({
        to: "/$org",
        params: { org: org.slug },
        search: { virtualmcpid: id ?? undefined },
      });
    } else {
      setScope(id);
    }
    onClose();
  };

  const travelTo = (slug: string, projectId?: string) => {
    track("org_project_travel", { scoped: !!projectId });
    navigate({
      to: "/$org",
      params: { org: slug },
      search: projectId ? { virtualmcpid: projectId } : {},
    });
    onClose();
  };

  const createProject = () => {
    track("picker_new_project");
    navigate({
      to: "/$org/agents/{-$panel}",
      params: { org: org.slug, panel: undefined },
      search: { virtualmcpid: undefined },
    });
    onClose();
  };

  rows.set(rowValue.allProjects, {
    kind: "scope",
    label: t("sidebar.scope.allProjects"),
  });

  return (
    <Command
      shouldFilter={false}
      value={active}
      onValueChange={setActive}
      className="max-h-[min(560px,70dvh)]"
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={t("sidebar.picker.searchPlaceholder")}
      />
      <CommandList>
        {searching ? (
          <>
            {/* A failed search is not an empty one: saying "nothing matches"
                when the request never landed invents an answer the server
                never gave. */}
            {isError && (
              <CommandEmpty>{t("sidebar.picker.searchFailed")}</CommandEmpty>
            )}
            {!isError && !isSearching && hits.length === 0 && (
              <CommandEmpty>
                {t("sidebar.picker.noMatches", { query: term })}
              </CommandEmpty>
            )}
            {!isError && hits.length > 0 && (
              /* These rows still answer the PREVIOUS term while the current
                 one is in flight — kept on screen so the list never blinks
                 empty under the cursor, dimmed so it never claims to be the
                 answer to what is in the field. */
              <CommandGroup
                heading={t("sidebar.picker.projectsHeading")}
                className={cn(isStale && "opacity-50")}
              >
                {hits.map((hit) => (
                  <SearchHitRow
                    key={`${hit.orgSlug}:${hit.id}`}
                    hit={hit}
                    currentOrgSlug={org.slug}
                    currentOrgName={org.name}
                    scopeId={scopeId}
                    rows={rows}
                    onScope={scopeTo}
                    onTravel={travelTo}
                  />
                ))}
              </CommandGroup>
            )}
          </>
        ) : (
          <>
            {/* "Projects", not "{org} · current": the trigger this popover
                hangs off already names the org, and the org is listed again
                below — three copies of one word in a list nine words long. */}
            <GroupHeading
              id={projectsHeadingId}
              label={t("sidebar.picker.projectsHeading")}
              createLabel={t("sidebar.picker.newProject")}
              onCreate={createProject}
            />
            <CommandGroup aria-labelledby={projectsHeadingId}>
              <CommandItem
                value={rowValue.allProjects}
                className={ROW}
                onSelect={() => scopeTo(null)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {t("sidebar.scope.allProjects")}
                </span>
                {scopeId === null && <Check size={14} />}
              </CommandItem>
              {projects.map((project) => {
                const value = rowValue.project(project.id);
                rows.set(value, { kind: "scope", label: project.title });
                return (
                  <CommandItem
                    key={project.id}
                    value={value}
                    className={ROW}
                    onSelect={() => scopeTo(project.id)}
                  >
                    <ProjectIcon icon={project.icon} name={project.title} />
                    <span className="min-w-0 flex-1 truncate">
                      {project.title}
                    </span>
                    {/* No org tag here, unlike a search hit: every row in this
                        group belongs to the org the trigger names, so the tag
                        was the same word repeated down the list. Search spans
                        organizations, so there it earns its place. */}
                    {scopeId === project.id && <Check size={14} />}
                  </CommandItem>
                );
              })}
              {hasMore && (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {t("sidebar.picker.moreExist")}
                </p>
              )}
            </CommandGroup>

            {/* UNCONDITIONAL, and it must stay that way: this heading
                carries the only "New organization" control in the product.
                `allOrgs` always has at least the current org, so the group is
                never empty in practice — but the heading must survive the one
                frame where the org list has not resolved yet, too. */}
            <GroupHeading
              id={orgsHeadingId}
              label={t("sidebar.picker.orgsHeading")}
              createLabel={t("sidebar.picker.newOrganization")}
              onCreate={onCreateOrg}
            />
            <CommandGroup aria-labelledby={orgsHeadingId}>
              {invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  onChanged={refetchInvitations}
                />
              ))}
              {allOrgs.map((candidate: PickerOrg) => {
                const isCurrent = candidate.slug === org.slug;
                const value = rowValue.org(candidate.slug);
                /** The current org is not travel — selecting it goes nowhere,
                 *  so the strip must not offer to leave anything. */
                rows.set(value, {
                  kind: isCurrent ? "scope" : "travel",
                  label: candidate.name,
                  ...(isCurrent ? {} : { leaves: org.name }),
                });
                return (
                  <CommandItem
                    key={candidate.id}
                    value={value}
                    className={ROW}
                    onSelect={() =>
                      isCurrent ? onClose() : travelTo(candidate.slug)
                    }
                  >
                    <OrgIcon org={candidate} size="xs" />
                    <span className="min-w-0 flex-1 truncate">
                      {candidate.name}
                    </span>
                    {/* The same check the scoped project wears: "where you
                        are" reads as one mark throughout, rather than a tick
                        in one group and the word "current" in the next. */}
                    {isCurrent && <Check size={14} />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>

      <VerbStrip active={active} rows={rows} />
    </Command>
  );
}

function SearchHitRow({
  hit,
  currentOrgSlug,
  currentOrgName,
  scopeId,
  rows,
  onScope,
  onTravel,
}: {
  hit: ProjectSearchHit;
  currentOrgSlug: string;
  currentOrgName: string;
  scopeId: string | null;
  rows: Map<string, RowMeta>;
  onScope: (id: string) => void;
  onTravel: (slug: string, projectId: string) => void;
}) {
  const isHere = hit.orgSlug === currentOrgSlug;
  const value = isHere
    ? rowValue.project(hit.id)
    : rowValue.foreignProject(hit.orgSlug, hit.id);

  rows.set(value, {
    kind: isHere ? "scope" : "travel",
    label: hit.title,
    leaves: isHere ? undefined : currentOrgName,
  });

  return (
    <CommandItem
      value={value}
      className={ROW}
      onSelect={() =>
        isHere ? onScope(hit.id) : onTravel(hit.orgSlug, hit.id)
      }
    >
      <ProjectIcon icon={hit.icon} name={hit.title} />
      <span className="min-w-0 flex-1 truncate">{hit.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {hit.orgName}
      </span>
      {isHere && scopeId === hit.id && <Check size={14} />}
    </CommandItem>
  );
}

/** The trigger, in the sidebar header where the org switcher used to be.
 *
 *  It names the SELECTION, and a project is a thing you selected — so it gets
 *  its own avatar and its own title, not the org's mark and a breadcrumb. With
 *  no project selected the org IS the selection, and the org is what shows.
 *  Same mark in the collapsed rail: the rail is this control with the text
 *  dropped, never a different answer to "where am I".
 *
 *  `project` (the resolved scope), never `displayTarget` (scope ELSE oldest): a
 *  fallback nobody chose must not be presented as a choice. Both marks are
 *  24px, so nothing shifts when the selection changes kind. */
export function OrgProjectPicker({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { project } = useProjectScope();
  const { invitations } = usePendingInvitations();
  const [open, setOpen] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);

  /** The rail shows a 24px mark and nothing else, so the tooltip carries the
   *  org a project belongs to — the one thing the mark cannot say. */
  const label = project
    ? t("sidebar.picker.projectInOrg", {
        project: project.title,
        org: org.name,
      })
    : org.name;

  /** A `div`, deliberately, not a `span`: `SidebarMenuButton` hides
   *  `>span:last-child` in the collapsed rail, and as the button's only child
   *  this wrapper WAS that node — so the rail painted an empty square where the
   *  org mark, the project avatar and the invitation dot should be. */
  const icon = (
    <div className="relative inline-flex shrink-0">
      {project ? (
        <AgentAvatar
          icon={project.icon}
          name={project.title}
          size="xs"
          className="shrink-0"
        />
      ) : (
        <OrgIcon org={org} size="sm" />
      )}
      {/* The invitation dot rides whichever mark is showing: it flags the
          control, not the organization it happens to be rendering. */}
      {invitations.length > 0 && (
        <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-destructive ring-2 ring-background" />
      )}
    </div>
  );

  const trigger = collapsed ? (
    <SidebarMenuButton tooltip={label} data-tour={LAYOUT_TOUR_ANCHORS.switcher}>
      {icon}
    </SidebarMenuButton>
  ) : (
    <button
      type="button"
      data-tour={LAYOUT_TOUR_ANCHORS.switcher}
      aria-label={t("sidebar.picker.ariaLabel", { name: label })}
      /* A nav row's pill edge; `pl-1` centres the 24px mark on its 16px icon. */
      className={cn(
        /* `md:h-[34px]` is the collapse toggle's height, so the two hover
           surfaces in this strip are one shape rather than two off by 2px. */
        "flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-1.5 text-left md:h-[34px] md:py-0",
        /* The sidebar's own hover, not the main panel's: `accent` is a lighter
           token than `sidebar-accent`, and at 60% over the sidebar it barely
           registered next to the collapse toggle it shares a strip with. */
        "[transition:background-color_180ms_ease] hover:bg-sidebar-accent",
        INSET_FOCUS_RING,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {project ? project.title : org.name}
      </span>
      <ChevronSelectorVertical
        size={14}
        className="shrink-0 text-muted-foreground"
      />
    </button>
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          side={collapsed ? "right" : "bottom"}
          align="start"
          className="w-[min(340px,calc(100vw-2rem))] p-0"
        >
          <PickerContent
            onClose={() => setOpen(false)}
            onCreateOrg={() => {
              setOpen(false);
              setCreatingOrg(true);
            }}
          />
        </PopoverContent>
      </Popover>
      {/* Sibling of the Popover, never inside its content: a dialog mounted in
          there unmounts with the popover the moment it takes focus. */}
      <CreateOrganizationDialog
        open={creatingOrg}
        onOpenChange={setCreatingOrg}
      />
    </>
  );
}
