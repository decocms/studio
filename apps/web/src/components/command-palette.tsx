/**
 * The ⌘K palette — reach without a nav row.
 *
 * The sidebar is a fixed five-row spine on purpose, which only works if there
 * is another way to get to everything it does not list: individual projects,
 * settings pages, the catalog, a task by name. That is this.
 *
 * Two kinds of result, deliberately separated:
 *
 *   LOCAL   — orgs, destinations, projects, settings pages, actions. Already in
 *             memory, so they appear on the first keystroke with no spinner and
 *             work offline. Every label goes through `t()`.
 *   REMOTE  — threads and tasks, via GLOBAL_SEARCH. Deferred, so typing never
 *             blocks on the network.
 *
 * cmdk does its own filtering over the rendered items, so the local groups are
 * rendered whole and it decides what matches. Remote rows carry the live term
 * in `keywords` so that filter always scores them — the server already matched
 * them, on text (a task key, a message body) that is not in their `value`.
 */

import { useDeferredValue, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  BarChartSquare02,
  Columns03,
  Compass03,
  Folder,
  Home02,
  MessageSquare01,
  Plus,
  Settings02,
  UserPlus01,
} from "@untitledui/icons";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { OrgIcon } from "@/components/header/org-switcher";
import { IntegrationIcon } from "@/components/integration-icon";
import { ProjectIcon } from "@/components/project-icon";
import {
  canonicalThreadRouteTarget,
  navigateToTabRouteTarget,
} from "@/layouts/main-panel-tabs/tab-route";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useRecentProjects } from "@/hooks/use-recent-projects";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useOrganizationSearch } from "@/hooks/use-organization-search";
import { useRecentOrgs } from "@/hooks/use-recent-orgs";
import { useTravelToOrg } from "@/hooks/use-travel-to-org";
import { useActiveOrganizations } from "@/lib/auth-client";
import { withCurrentOrg } from "@/lib/recent-orgs";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import {
  KEYS,
  SELF_MCP_ALIAS_ID,
  getWellKnownDecopilotVirtualMCP,
  useMCPClientNonBlocking,
  useProjectContext,
} from "@/sdk";

/** Mirrors GLOBAL_SEARCH's discriminated union, narrowed to what we render. */
type SearchHit =
  | {
      type: "thread";
      id: string;
      title: string;
      virtual_mcp_id: string | null;
    }
  | { type: "task"; id: string; title: string; key: string | null }
  | {
      type: "connection";
      id: string;
      title: string;
      icon: string | null;
      slug: string | null;
    };

/**
 * GLOBAL_SEARCH, on the deferred term.
 *
 * Fails silently to an empty list: a palette whose local half still works is
 * far better than one that renders an error over the results you can already
 * see.
 */
/** The palette lists a few best matches; the threads-panel dialog pages. */
const PALETTE_LIMIT = 8;

const SCOPES = [
  "all",
  "organizations",
  "projects",
  "chats",
  "connections",
  "actions",
] as const;
type Scope = (typeof SCOPES)[number];

/** Orgs shown under "All" before anything is typed; the chip lists them all. */
const ORG_PREVIEW_LIMIT = 5;

interface PaletteOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

function scopeLabelKey(scope: Scope) {
  switch (scope) {
    case "all":
      return "commandPalette.scope.all" as const;
    case "organizations":
      return "commandPalette.organizations" as const;
    case "projects":
      return "commandPalette.projects" as const;
    case "chats":
      return "commandPalette.scope.chats" as const;
    case "connections":
      return "commandPalette.connections" as const;
    case "actions":
      return "commandPalette.actions" as const;
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

/** Recent first (the order the rail keeps), then the rest by name. */
function orderOrgs(
  orgs: readonly PaletteOrg[],
  recent: readonly string[],
): PaletteOrg[] {
  const rank = (slug: string) => {
    const at = recent.indexOf(slug);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  return [...orgs].sort(
    (a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name),
  );
}

function useGlobalSearch(term: string, enabled: boolean): SearchHit[] {
  const { org } = useProjectContext();
  /** Non-blocking on purpose: the palette mounts on ⌘K, outside every Suspense
   *  boundary but the root, so suspending on the self-MCP connect (uncached on
   *  a cold load or an org switch) would replace the painted app with the
   *  splash screen. Until it connects there are simply no remote hits. */
  const client = useMCPClientNonBlocking({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useQuery({
    queryKey: KEYS.globalSearch(org.id, term, PALETTE_LIMIT),
    enabled: enabled && !!client && term.trim().length >= 2,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      if (!client) return [];
      try {
        const result = (await client.callTool({
          name: "GLOBAL_SEARCH",
          arguments: { query: term, limit: PALETTE_LIMIT },
        })) as { structuredContent?: { items?: SearchHit[] } };
        return result.structuredContent?.items ?? [];
      } catch {
        return [];
      }
    },
  });

  return data ?? [];
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { projects, hasProjects } = useProjectScope();
  const { remember: rememberProject } = useRecentProjects(org.slug);
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const shows = (kind: Scope) => scope === "all" || scope === kind;
  const deferredTerm = useDeferredValue(term);
  const hits = useGlobalSearch(
    deferredTerm,
    shows("chats") || shows("connections"),
  );

  /** Orgs: the in-memory list, plus the server's matches past Better Auth's
   *  first 500 memberships once something is typed. */
  const travelToOrg = useTravelToOrg();
  const { data: organizations } = useActiveOrganizations();
  const { recent: recentOrgs } = useRecentOrgs();
  const typed = term.trim();
  const orgTerm = useDebouncedValue(typed, 150);
  const { hits: orgHits } = useOrganizationSearch(
    shows("organizations") ? orgTerm : "",
  );
  const memberOrgs = orderOrgs(
    withCurrentOrg((organizations ?? []) as PaletteOrg[], org),
    recentOrgs,
  );
  const serverOrgIds = new Set(orgHits.map((hit) => hit.id));
  const allOrgs = [
    ...memberOrgs,
    ...orgHits.filter((hit) => !memberOrgs.some((o) => o.id === hit.id)),
  ];
  /** Under "All" with nothing typed, a short list of the OTHER orgs — the one
   *  you are in is not where you are going. */
  const paletteOrgs =
    scope === "all" && !typed
      ? allOrgs.filter((it) => it.slug !== org.slug).slice(0, ORG_PREVIEW_LIMIT)
      : allOrgs;

  const close = () => {
    onOpenChange(false);
    setTerm("");
    setScope("all");
  };

  const cycleScope = (step: 1 | -1) => {
    const at = SCOPES.indexOf(scope);
    setScope(SCOPES[(at + step + SCOPES.length) % SCOPES.length] ?? "all");
  };

  const go = (fn: () => void, what: string) => {
    track("command_palette_used", { kind: what });
    fn();
    close();
  };

  /**
   * A card is addressed by its human key, a thread by `?thread=` on its own
   * project's route — the same two addresses the rest of the app uses, so a
   * palette hit and a sidebar click land in the identical place.
   *
   * A card with no key (a row predating the key backfill) has no path form, so
   * it falls back to the lanes rather than minting a URL that resolves to
   * nothing.
   */
  const openHit = (hit: SearchHit) => {
    if (hit.type === "connection") {
      /** `slug` is what the detail route keys on. A row without one has no
       *  detail page, so it falls back to the connections list rather than
       *  minting a URL that resolves to nothing — same rule as a keyless
       *  card below. */
      if (!hit.slug) {
        navigate({
          to: "/$org/settings/connections",
          params: { org: org.slug },
          search: { tab: "all" as const },
        });
        return;
      }
      navigate({
        to: "/$org/settings/connections/$appSlug",
        params: { org: org.slug, appSlug: hit.slug },
      });
      return;
    }
    if (hit.type === "task") {
      navigate({
        to: DESTINATION_ROUTE.tasks,
        params: { org: org.slug, taskKey: hit.key ?? undefined },
      });
      return;
    }
    const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
    navigateToTabRouteTarget(
      navigate,
      canonicalThreadRouteTarget({
        org: org.slug,
        agentId: hit.virtual_mcp_id ?? decopilotId,
        superAgentId: decopilotId,
      }),
      { search: () => ({ thread: hit.id }), replace: false },
    );
  };

  /** The one thing that keeps a server-matched row on screen: cmdk scores an
   *  item over `value` PLUS `keywords`, so handing it the live term is an
   *  exact match and a guaranteed non-zero score. Without it a hit matched on
   *  a task key or a message body — text that is not in `value` — scores 0 and
   *  cmdk unmounts it, and the server's answer renders as "No results". `term`,
   *  not `deferredTerm`: cmdk filters against what is in the input right now. */
  const remoteKeywords = [term];

  const connectionHits = hits.filter((hit) => hit.type === "connection");
  const resultHits = hits.filter((hit) => hit.type !== "connection");

  const orgParams = { org: org.slug };

  const destinations = [
    {
      key: "home",
      label: t("sidebar.navDestinations.home"),
      icon: <Home02 aria-hidden="true" />,
      to: DESTINATION_ROUTE.home,
      params: orgParams,
    },
    {
      key: "reports",
      label: t("sidebar.navDestinations.reports"),
      icon: <BarChartSquare02 aria-hidden="true" />,
      to: DESTINATION_ROUTE.reports,
      params: orgParams,
    },
    {
      key: "tasks",
      label: t("sidebar.navDestinations.tasks"),
      icon: <Columns03 aria-hidden="true" />,
      to: DESTINATION_ROUTE.tasks,
      params: { org: org.slug, taskKey: undefined },
    },
    {
      key: "library",
      label: t("sidebar.navDestinations.library"),
      icon: <Folder aria-hidden="true" />,
      to: DESTINATION_ROUTE.library,
      params: orgParams,
    },
    {
      key: "discover",
      label: t("sidebar.navDestinations.discover"),
      icon: <Compass03 aria-hidden="true" />,
      to: DESTINATION_ROUTE.discover,
      params: orgParams,
    },
  ] as const;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={t("commandPalette.title")}
      description={t("commandPalette.description")}
    >
      <CommandInput
        placeholder={
          scope === "all"
            ? t("commandPalette.placeholder")
            : t("commandPalette.placeholderScoped", {
                scope: t(scopeLabelKey(scope)).toLowerCase(),
              })
        }
        aria-label={t("commandPalette.placeholder")}
        value={term}
        onValueChange={setTerm}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            cycleScope(event.shiftKey ? -1 : 1);
            return;
          }
          /** Backspace on an empty field steps out of the scope first. */
          if (event.key === "Backspace" && !term && scope !== "all") {
            event.preventDefault();
            setScope("all");
          }
        }}
      />
      <div
        role="radiogroup"
        aria-label={t("commandPalette.scope.label")}
        className="flex gap-1 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SCOPES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={scope === option}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setScope(option)}
            className={cn(
              "h-7 shrink-0 cursor-pointer rounded-full px-3 text-xs font-medium transition-colors focus-ring",
              scope === option
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(scopeLabelKey(option))}
          </button>
        ))}
      </div>
      <CommandList className="h-[min(420px,60vh)] max-h-none">
        <CommandEmpty>{t("commandPalette.empty")}</CommandEmpty>

        {shows("organizations") && paletteOrgs.length > 0 && (
          <CommandGroup heading={t("commandPalette.organizations")}>
            {paletteOrgs.map((candidate) => (
              <CommandItem
                key={`org:${candidate.id}`}
                value={`org ${candidate.name} ${candidate.slug}`}
                keywords={serverOrgIds.has(candidate.id) ? [term] : undefined}
                onSelect={() =>
                  go(() => travelToOrg(candidate.slug), "organization")
                }
              >
                <OrgIcon org={candidate} size="xs" />
                <span className="min-w-0 flex-1 truncate">
                  {candidate.name}
                </span>
                {candidate.slug === org.slug && (
                  <span className="text-meta shrink-0">
                    {t("sidebar.rail.currentOrganization")}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {shows("actions") && (
          <CommandGroup heading={t("commandPalette.goTo")}>
            {destinations.map((destination) => (
              <CommandItem
                key={destination.key}
                onSelect={() =>
                  go(
                    () =>
                      navigate({
                        to: destination.to,
                        params: destination.params,
                      }),
                    "destination",
                  )
                }
              >
                {destination.icon}
                <span>{destination.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {shows("projects") && hasProjects && (
          <CommandGroup heading={t("commandPalette.projects")}>
            {projects.map((project) => (
              /** Opens the workspace rather than setting the scope: "go to" is
               *  what a palette entry means, and with one project it is the
               *  only route to Preview / Code / Content. Scoping is the chip's
               *  job. */
              <CommandItem
                key={project.id}
                value={`project ${project.title}`}
                onSelect={() =>
                  go(() => {
                    /** Opening a project puts it on the rail, the same as
                     *  `useNavigateToAgent` does for every other entry point. */
                    rememberProject(project.id);
                    navigate({
                      to: DESTINATION_ROUTE.projects,
                      params: { org: org.slug, agentId: project.id },
                    });
                  }, "project")
                }
              >
                <ProjectIcon
                  icon={project.icon}
                  name={project.title}
                  aria-hidden="true"
                />
                <span>{project.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {shows("actions") && (
          <CommandGroup heading={t("commandPalette.actions")}>
            <CommandItem
              value={t("commandPalette.newProject")}
              onSelect={() =>
                go(
                  () =>
                    navigate({
                      to: DESTINATION_ROUTE.home,
                      params: orgParams,
                    }),
                  "new_project",
                )
              }
            >
              <Plus aria-hidden="true" />
              <span>{t("commandPalette.newProject")}</span>
            </CommandItem>
            <CommandItem
              value={t("commandPalette.inviteTeammate")}
              onSelect={() =>
                go(
                  () =>
                    navigate({
                      to: "/$org/settings/members",
                      params: orgParams,
                    }),
                  "invite",
                )
              }
            >
              <UserPlus01 aria-hidden="true" />
              <span>{t("commandPalette.inviteTeammate")}</span>
            </CommandItem>
            <CommandItem
              value={t("commandPalette.addConnection")}
              onSelect={() =>
                go(
                  () =>
                    navigate({
                      to: "/$org/settings/connections",
                      params: orgParams,
                      search: { tab: "all" as const },
                    }),
                  "add_connection",
                )
              }
            >
              <Plus aria-hidden="true" />
              <span>{t("commandPalette.addConnection")}</span>
            </CommandItem>
            <CommandItem
              value={t("commandPalette.settings")}
              onSelect={() =>
                go(
                  () =>
                    navigate({
                      to: "/$org/settings/general",
                      params: orgParams,
                    }),
                  "settings",
                )
              }
            >
              <Settings02 aria-hidden="true" />
              <span>{t("commandPalette.settings")}</span>
            </CommandItem>
          </CommandGroup>
        )}

        {shows("connections") && connectionHits.length > 0 && (
          <CommandGroup heading={t("commandPalette.connections")}>
            {connectionHits.map((hit) => (
              <CommandItem
                key={`connection:${hit.id}`}
                value={`${hit.title} ${hit.id}`}
                keywords={remoteKeywords}
                onSelect={() => go(() => openHit(hit), "connection")}
              >
                {/* 2xs matches ProjectIcon: one 16px mark for every named thing in the list. */}
                <IntegrationIcon
                  icon={hit.icon}
                  name={hit.title}
                  size="2xs"
                  aria-hidden="true"
                />
                <span className="truncate">{hit.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {shows("chats") && resultHits.length > 0 && (
          <CommandGroup heading={t("commandPalette.results")}>
            {resultHits.map((hit) => (
              <CommandItem
                key={`${hit.type}:${hit.id}`}
                value={`${hit.title} ${hit.id}`}
                keywords={remoteKeywords}
                onSelect={() => go(() => openHit(hit), hit.type)}
              >
                {hit.type === "thread" ? (
                  <MessageSquare01 aria-hidden="true" />
                ) : (
                  <Columns03 aria-hidden="true" />
                )}
                <span className="truncate">{hit.title}</span>
                {hit.type === "task" && hit.key && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                    {hit.key}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
        <PaletteHint
          keys={["↑", "↓"]}
          label={t("commandPalette.hint.navigate")}
        />
        <PaletteHint keys={["↵"]} label={t("commandPalette.hint.open")} />
        <PaletteHint keys={["Tab"]} label={t("commandPalette.hint.filter")} />
        <PaletteHint keys={["Esc"]} label={t("commandPalette.hint.close")} />
      </div>
    </CommandDialog>
  );
}

function PaletteHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5">
        {keys.map((key) => (
          <kbd
            key={key}
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-muted px-1 font-mono text-2xs"
          >
            {key}
          </kbd>
        ))}
      </span>
      {label}
    </span>
  );
}
