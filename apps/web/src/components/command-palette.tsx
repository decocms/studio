/**
 * The ⌘K palette — reach without a nav row.
 *
 * The sidebar is a fixed five-row spine on purpose, which only works if there
 * is another way to get to everything it does not list: individual projects,
 * settings pages, the catalog, a task by name. That is this.
 *
 * Two kinds of result, deliberately separated:
 *
 *   LOCAL   — destinations, projects, settings pages, actions. Already in
 *             memory, so they appear on the first keystroke with no spinner and
 *             work offline. Every label goes through `t()`.
 *   REMOTE  — threads and tasks, via GLOBAL_SEARCH. Deferred, so typing never
 *             blocks on the network.
 *
 * cmdk does its own filtering over the rendered items, so the local groups are
 * rendered whole and it decides what matches. The remote group is fetched on
 * the deferred term and rendered with `value` set to the raw text so cmdk does
 * not filter server results a second time.
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
import { AgentAvatar } from "@/components/agent-icon";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import {
  KEYS,
  SELF_MCP_ALIAS_ID,
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
  | { type: "task"; id: string; title: string; key: string | null };

/**
 * GLOBAL_SEARCH, on the deferred term.
 *
 * Fails silently to an empty list: a palette whose local half still works is
 * far better than one that renders an error over the results you can already
 * see.
 */
/** The palette lists a few best matches; the threads-panel dialog pages. */
const PALETTE_LIMIT = 8;

function useGlobalSearch(term: string): SearchHit[] {
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
    enabled: !!client && term.trim().length >= 2,
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
  const [term, setTerm] = useState("");
  const deferredTerm = useDeferredValue(term);
  const hits = useGlobalSearch(deferredTerm);

  const close = () => {
    onOpenChange(false);
    setTerm("");
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
    if (hit.type === "task") {
      navigate({
        to: DESTINATION_ROUTE.tasks,
        params: { org: org.slug, taskKey: hit.key ?? undefined },
      });
      return;
    }
    navigate({
      to: DESTINATION_ROUTE.agents,
      params: { org: org.slug, panel: undefined },
      search: {
        virtualmcpid: hit.virtual_mcp_id ?? undefined,
        thread: hit.id,
      },
    });
  };

  const orgParams = { org: org.slug };

  const destinations = [
    {
      key: "home",
      label: t("sidebar.navDestinations.home"),
      icon: <Home02 />,
      to: DESTINATION_ROUTE.home,
      params: orgParams,
    },
    {
      key: "reports",
      label: t("sidebar.navDestinations.reports"),
      icon: <BarChartSquare02 />,
      to: DESTINATION_ROUTE.reports,
      params: orgParams,
    },
    {
      key: "tasks",
      label: t("sidebar.navDestinations.tasks"),
      icon: <Columns03 />,
      to: DESTINATION_ROUTE.tasks,
      params: { org: org.slug, taskKey: undefined },
    },
    {
      key: "library",
      label: t("sidebar.navDestinations.library"),
      icon: <Folder />,
      to: DESTINATION_ROUTE.library,
      params: orgParams,
    },
    {
      key: "discover",
      label: t("sidebar.navDestinations.discover"),
      icon: <Compass03 />,
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
        placeholder={t("commandPalette.placeholder")}
        value={term}
        onValueChange={setTerm}
      />
      <CommandList>
        <CommandEmpty>{t("commandPalette.empty")}</CommandEmpty>

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

        {hasProjects && (
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
                  go(
                    () =>
                      navigate({
                        to: DESTINATION_ROUTE.agents,
                        params: { org: org.slug, panel: undefined },
                        search: { virtualmcpid: project.id },
                      }),
                    "project",
                  )
                }
              >
                <AgentAvatar
                  icon={project.icon}
                  name={project.title}
                  size="2xs"
                />
                <span>{project.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading={t("commandPalette.actions")}>
          <CommandItem
            value={t("commandPalette.newProject")}
            onSelect={() =>
              go(
                () =>
                  navigate({
                    to: DESTINATION_ROUTE.agents,
                    params: { org: org.slug, panel: undefined },
                    /** "New project" is the Super Agent, so the scope is
                     *  explicitly cleared rather than inherited. */
                    search: { virtualmcpid: undefined },
                  }),
                "new_project",
              )
            }
          >
            <Plus />
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
            <UserPlus01 />
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
            <Plus />
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
            <Settings02 />
            <span>{t("commandPalette.settings")}</span>
          </CommandItem>
        </CommandGroup>

        {hits.length > 0 && (
          <CommandGroup heading={t("commandPalette.results")}>
            {hits.map((hit) => (
              /** `value` is the raw title so cmdk does not re-filter what the
               *  server already matched. */
              <CommandItem
                key={`${hit.type}:${hit.id}`}
                value={`${hit.title} ${hit.id}`}
                onSelect={() => go(() => openHit(hit), hit.type)}
              >
                {hit.type === "thread" ? <MessageSquare01 /> : <Columns03 />}
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
    </CommandDialog>
  );
}
