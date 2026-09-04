/**
 * Pure compatibility adapters for URLs written before main views became
 * route-owned pages.
 *
 * Legacy URLs encoded agent identity in `?virtualmcpid=` and a view in either
 * `?main=` or an `/agents/<panel>` segment. Canonical URLs encode both in the
 * route tree: `/agents/$agentId/...`. These helpers are the one-way boundary
 * between those grammars. They accept every unambiguous old shape, but every
 * emitted target is canonical; an adapter never redirects through another
 * legacy URL. An unmarked custom view named exactly like an agent-id namespace
 * is syntactically indistinguishable from a canonical path with stale search,
 * so canonical path identity wins that one retired collision.
 */

import { AGENT_ROUTE, DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import {
  isKnownPanelSegment,
  tabIdForPanel,
} from "@/layouts/main-panel-tabs/panel-route";
import { GATED_CONTROL_PLANE_TABS } from "@/layouts/main-panel-tabs/tab-id";
import {
  type TabRouteTarget,
  tabRouteTarget,
} from "@/layouts/main-panel-tabs/tab-route";
import {
  isBrandContextSetup,
  isCommerceDiscoveryAgentId,
  isDecopilot,
  isSiteDiagnostics,
  isStudioPackAgent,
} from "@/sdk";

/** Search accepted from a legacy URL. Unknown keys are deliberately retained:
 * they include shared layout state, board filters and feature deep links. */
export interface LegacyThreadSearch {
  virtualmcpid?: string;
  main?: string | 0;
  [key: string]: unknown;
}

/** A canonical route plus the complete search object to write on it. Keeping
 * the typed route separate from preserved search lets redirect components
 * retain TanStack's route-param checking without casting a union. */
export interface LegacyCanonicalTarget {
  route: TabRouteTarget;
  search: Record<string, unknown>;
}

/** Whether a matched `/$org/agents/$agentId` route has another path segment.
 * Segment counting is deliberate: searching for `"/agents/"` is ambiguous
 * when the organization slug itself is `"agents"`. Query strings are absent
 * from TanStack's `location.pathname`; trailing slashes add no segment. */
export function agentWorkspacePathHasChild(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments[1] === "agents" && segments.length > 3;
}

/** `main=0` changes layout on the current route; every named view moves to a
 * canonical route. */
export type LegacyMainTranslation =
  | { kind: "same-route"; search: Record<string, unknown> }
  | ({ kind: "canonical" } & LegacyCanonicalTarget);

/** Old panel payloads are routing state, not shared search. Remove all of them
 * before applying the canonical destination's own payload so stale state from
 * another panel can never survive the migration. */
const LEGACY_VIEW_SEARCH_KEYS: ReadonlySet<string> = new Set([
  "main",
  "virtualmcpid",
  "file",
  "key",
  "deck",
  "path",
  "connection",
  "tool",
  "automation",
]);

const LEGACY_MAIN_SEARCH_KEY: ReadonlySet<string> = new Set(["main"]);
const LEGACY_AGENT_SEARCH_KEY: ReadonlySet<string> = new Set(["virtualmcpid"]);

function withoutKeys(
  search: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(search).filter(([key]) => !keys.has(key)),
  );
}

function canonicalSearch(
  search: Readonly<Record<string, unknown>>,
  route: TabRouteTarget,
): Record<string, unknown> {
  return {
    ...withoutKeys(search, LEGACY_VIEW_SEARCH_KEYS),
    ...route.search,
  };
}

/** Remove a redundant search-carried identity after a canonical agent path has
 * won. Kept pure so the render-time adapter never mutates router search. */
export function retireLegacyAgentSearch(
  search: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return withoutKeys(search, LEGACY_AGENT_SEARCH_KEY);
}

/**
 * Retire search-carried identity that arrives on a canonical organization
 * destination. Historical scoped Home links still mean "open this agent";
 * other destination pages are organization-owned and simply discard the
 * stale identity.
 */
export function translateLegacyOrgDestinationAgentSearch(args: {
  org: string;
  routePath: string;
  search: LegacyThreadSearch;
}): LegacyMainTranslation | null {
  if (args.search.virtualmcpid === undefined) return null;

  if (args.routePath === DESTINATION_ROUTE.home) {
    const agentId = normalizedAgentId(args.search.virtualmcpid);
    if (agentId) {
      const route = canonicalBaseRoute(args.org, agentId);
      return {
        kind: "canonical",
        route,
        search: canonicalSearch(args.search, route),
      };
    }
  }

  if (
    args.routePath === DESTINATION_ROUTE.home ||
    args.routePath === DESTINATION_ROUTE.tasks ||
    args.routePath === DESTINATION_ROUTE.reports ||
    args.routePath === DESTINATION_ROUTE.library
  ) {
    return {
      kind: "same-route",
      search: retireLegacyAgentSearch(args.search),
    };
  }

  return null;
}

function normalizedAgentId(agentId: string | undefined): string | undefined {
  return agentId?.trim() || undefined;
}

/** Whether the first segment after `/agents/` belongs to the retired
 * view-first grammar rather than naming a canonical agent. */
function isLegacyAgentPanelSegment(segment: string | undefined): boolean {
  return (
    isKnownPanelSegment(segment) ||
    (segment !== undefined && GATED_CONTROL_PLANE_TABS.has(segment))
  );
}

/**
 * Every persisted agent id is generated with `vir_`; the remaining valid
 * shapes are centralized well-known ids. This discriminator preserves old
 * view-first URLs whose view names are outside those namespaces while a
 * canonical `/agents/vir_x?virtualmcpid=vir_stale` still lets path identity
 * win. A custom view deliberately named like an agent id is irreducibly
 * ambiguous in that retired unmarked URL shape; canonical path identity wins.
 */
export function isCanonicalAgentIdSegment(
  segment: string | undefined,
): boolean {
  const id = normalizedAgentId(segment);
  if (!id) return false;
  return (
    (id.startsWith("vir_") && id.length > "vir_".length) ||
    isDecopilot(id) !== null ||
    isBrandContextSetup(id) !== null ||
    isSiteDiagnostics(id) !== null ||
    isCommerceDiscoveryAgentId(id) !== null ||
    isStudioPackAgent(id)
  );
}

/** Resolve identity while both route grammars can still arrive. A canonical
 * path is authoritative over a stale query. The only exception is a first
 * segment that is itself a known legacy view (`/agents/code?...`), where that
 * segment is the view and the old query still carries the agent. */
export function resolveLegacyAgentId(input: {
  agentIdParam?: string;
  virtualMcpIdSearch?: string;
  fallbackAgentId?: string;
}): string | undefined {
  const pathAgentId = normalizedAgentId(input.agentIdParam);
  const pathNamesLegacyView = isLegacyAgentPanelSegment(pathAgentId);

  if (pathAgentId && !pathNamesLegacyView) return pathAgentId;
  return (
    normalizedAgentId(input.virtualMcpIdSearch) ??
    normalizedAgentId(input.fallbackAgentId)
  );
}

/**
 * Resolve the retired `/agents/<view>` grammar after the authenticated org
 * shell has mounted. Keeping the Super Agent fallback here, rather than in a
 * router loader, makes this adapter independent of a second organization-list
 * request and lets every redirect preserve the original search and hash.
 *
 * `null` means the current path is canonical (or belongs to a canonical child),
 * so callers must leave it alone. Every recognized legacy path returns a
 * canonical target: a non-empty panel plus the mounted org's fallback identity
 * is sufficient for {@link translateLegacyPanelRoute} to resolve every shape.
 */
export function translateLegacyAgentPath(args: {
  pathname: string;
  org: string;
  pathAgentId?: string;
  pathLegacyView?: string;
  fallbackAgentId: string;
  search: LegacyThreadSearch;
}): LegacyCanonicalTarget | null {
  const pathAgentId = args.pathAgentId;

  if (pathAgentId && args.pathLegacyView) {
    const translation = translateLegacyPanelRoute({
      org: args.org,
      agentId: pathAgentId,
      panel: args.pathLegacyView,
      source: "project-first",
      search: args.search,
    });
    return translation?.kind === "canonical"
      ? { route: translation.route, search: translation.search }
      : null;
  }

  if (!pathAgentId || agentWorkspacePathHasChild(args.pathname)) return null;

  const opaqueViewFirst =
    args.search.virtualmcpid !== undefined &&
    !isCanonicalAgentIdSegment(pathAgentId);
  const isLegacyPath =
    isLegacyAgentPanelSegment(pathAgentId) || opaqueViewFirst;
  if (!isLegacyPath) return null;

  const agentId = resolveLegacyAgentId({
    agentIdParam: opaqueViewFirst ? undefined : pathAgentId,
    virtualMcpIdSearch: args.search.virtualmcpid,
    fallbackAgentId: args.fallbackAgentId,
  });
  const translation = translateLegacyPanelRoute({
    org: args.org,
    agentId,
    panel: pathAgentId,
    source: "view-first",
    search: args.search,
  });

  return translation?.kind === "canonical"
    ? { route: translation.route, search: translation.search }
    : null;
}

/** `main` values that always meant an org-owned destination. In particular,
 * legacy `main=overview` opened org Home; it must not silently change meaning
 * now that an agent overview route also exists. */
function legacyDestinationTarget(
  main: string,
  org: string,
  search: Readonly<Record<string, unknown>>,
): TabRouteTarget | null {
  switch (main) {
    case "board":
      return {
        to: DESTINATION_ROUTE.tasks,
        params: { org, taskKey: undefined },
        search: {},
      };
    case "files": {
      const path = stringSearchValue(search.path);
      return {
        to: DESTINATION_ROUTE.library,
        params: { org },
        search: path ? { path } : {},
      };
    }
    case "reports":
      return { to: DESTINATION_ROUTE.reports, params: { org }, search: {} };
    case "overview":
      return { to: DESTINATION_ROUTE.home, params: { org }, search: {} };
    case "discover":
      return { to: DESTINATION_ROUTE.home, params: { org }, search: {} };
    default:
      return null;
  }
}

/** Map an old tab/panel vocabulary item directly to its canonical owner. */
function canonicalRouteForLegacyTab(args: {
  org: string;
  agentId?: string;
  tabId: string;
  search: Readonly<Record<string, unknown>>;
}): TabRouteTarget | null {
  const destination = legacyDestinationTarget(
    args.tabId,
    args.org,
    args.search,
  );
  if (destination) return destination;

  if (args.tabId === "chat") {
    return canonicalBaseRoute(args.org, args.agentId);
  }

  const agentId = normalizedAgentId(args.agentId);
  if (!agentId) return null;

  /** These were parameterized panel kinds, never standalone tab ids. A
   * truncated legacy link has no entity to open, so its safest canonical home
   * is the owning agent rather than a fabricated `/views/app`-style route. */
  if (
    args.tabId === "app" ||
    args.tabId === "file" ||
    args.tabId === "deck" ||
    args.tabId === "library-file" ||
    args.tabId.trim() === ""
  ) {
    return {
      to: AGENT_ROUTE.root,
      params: { org: args.org, agentId },
      search: {},
    };
  }

  return tabRouteTarget({ org: args.org, agentId, tabId: args.tabId });
}

function canonicalBaseRoute(org: string, agentId?: string): TabRouteTarget {
  const normalized = normalizedAgentId(agentId);
  return normalized
    ? {
        to: AGENT_ROUTE.root,
        params: { org, agentId: normalized },
        search: {},
      }
    : {
        to: DESTINATION_ROUTE.home,
        params: { org },
        search: {},
      };
}

/**
 * Translate a legacy `?main=` without an intermediate panel URL.
 *
 * `null` means there is no legacy input, or a named agent view arrived without
 * enough identity to form a canonical URL. Callers mounted inside the app can
 * supply the org's Decopilot id for that malformed/unscoped historical case.
 */
export function translateLegacyMainParam(args: {
  org: string;
  agentId?: string;
  main: string | 0 | undefined;
  search?: LegacyThreadSearch | null;
}): LegacyMainTranslation | null {
  const { main } = args;
  if (main === undefined) return null;

  const search = args.search ?? {};
  if (main === 0 || main === "0") {
    return {
      kind: "same-route",
      search: {
        ...withoutKeys(search, LEGACY_MAIN_SEARCH_KEY),
        mainpanel: false,
      },
    };
  }

  /** `chat` was the retired "no main view" default, not an agent-declared
   * view. Its canonical expression is the base page with chat visible. */
  if (main === "chat") {
    const route = canonicalBaseRoute(args.org, args.agentId);
    return {
      kind: "canonical",
      route,
      search: {
        ...canonicalSearch(search, route),
        sidepanel: true,
        mainpanel: false,
      },
    };
  }

  const route = canonicalRouteForLegacyTab({
    org: args.org,
    agentId: args.agentId,
    tabId: main,
    search,
  });
  if (!route) return null;

  return {
    kind: "canonical",
    route,
    search: canonicalSearch(search, route),
  };
}

function stringSearchValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Translate the old `/agents/<panel>?virtualmcpid=<id>` (and the briefly
 * shipped `/agents/<agent>/<panel>`) grammar directly to a canonical route.
 * A legacy `?main=` wins when both forms are present, matching the old shell.
 */
export function translateLegacyPanelRoute(args: {
  org: string;
  agentId?: string;
  panel?: string;
  source?: "view-first" | "project-first";
  search?: LegacyThreadSearch | null;
}): LegacyMainTranslation | null {
  const search = args.search ?? {};
  if ((search.main === 0 || search.main === "0") && args.panel) {
    const panelTarget = translateLegacyPanelRoute({
      ...args,
      search: withoutKeys(search, LEGACY_MAIN_SEARCH_KEY),
    });
    if (panelTarget?.kind !== "canonical") return panelTarget;
    return {
      ...panelTarget,
      search: { ...panelTarget.search, mainpanel: false },
    };
  }
  if (search.main !== undefined) {
    return translateLegacyMainParam({
      org: args.org,
      agentId: args.agentId,
      main: search.main,
      search,
    });
  }

  const agentId = normalizedAgentId(args.agentId);
  const panel = args.panel;
  if (!panel) {
    const route = canonicalBaseRoute(args.org, agentId);
    return {
      kind: "canonical",
      route,
      search: canonicalSearch(search, route),
    };
  }

  const tabId = tabIdForPanel(panel, {
    file: stringSearchValue(search.file),
    key: stringSearchValue(search.key),
    deck: stringSearchValue(search.deck),
    path: stringSearchValue(search.path),
    connection: stringSearchValue(search.connection),
    tool: stringSearchValue(search.tool),
    automation: stringSearchValue(search.automation),
  });
  const route = tabId
    ? args.source === "project-first" && tabId === "overview" && agentId
      ? tabRouteTarget({ org: args.org, agentId, tabId })
      : canonicalRouteForLegacyTab({ org: args.org, agentId, tabId, search })
    : canonicalRouteForLegacyTab({
        org: args.org,
        agentId,
        tabId: "",
        search,
      });
  if (!route) return null;

  return {
    kind: "canonical",
    route,
    search:
      tabId === "chat"
        ? {
            ...canonicalSearch(search, route),
            sidepanel: true,
            mainpanel: false,
          }
        : canonicalSearch(search, route),
  };
}

/**
 * Translate the forever-supported `/$org/$taskId` route.
 *
 * A base thread URL with agent identity lands at that agent's root; without
 * it, it lands on org Home. A named `main` may override the root with its
 * canonical owner. Org destinations need no agent; an agent-owned view uses
 * the optional Super Agent fallback supplied by the mounted org shell, while
 * the pure adapter still falls back to Home when no identity is available.
 */
export function translateLegacyThreadRoute(args: {
  org: string;
  taskId: string;
  /** The org's Super Agent. Used only when an old URL names an agent-owned
   * view but predates query-carried identity. */
  fallbackAgentId?: string;
  search?: LegacyThreadSearch | null;
}): LegacyCanonicalTarget {
  const search = args.search ?? {};
  const agentId = normalizedAgentId(search.virtualmcpid);
  const fallbackAgentId = normalizedAgentId(args.fallbackAgentId);
  const main = search.main;

  let route: TabRouteTarget;
  if (main === "chat") {
    route = canonicalBaseRoute(args.org, agentId);
  } else if (main !== undefined && main !== 0 && main !== "0") {
    const explicitTarget = canonicalRouteForLegacyTab({
      org: args.org,
      agentId,
      tabId: main,
      search,
    });
    const fallbackTarget =
      !explicitTarget && main.trim().length > 0 && fallbackAgentId
        ? canonicalRouteForLegacyTab({
            org: args.org,
            agentId: fallbackAgentId,
            tabId: main,
            search,
          })
        : null;
    route =
      explicitTarget ??
      fallbackTarget ??
      ({
        to: DESTINATION_ROUTE.home,
        params: { org: args.org },
        search: {},
      } satisfies TabRouteTarget);
  } else {
    route = canonicalBaseRoute(args.org, agentId);
  }

  return {
    route,
    search: {
      ...canonicalSearch(search, route),
      ...(main === 0 || main === "0" ? { mainpanel: false } : {}),
      ...(main === "chat" ? { sidepanel: true, mainpanel: false } : {}),
      thread: args.taskId,
    },
  };
}

/** What a legacy `?task=` becomes: the optional task-key segment and search
 * without the retired echo. */
export interface LegacyTaskTarget<T> {
  taskKey: string | undefined;
  search: T;
}

export function promoteLegacyTaskParam<T extends { task?: string }>(
  taskKey: string | undefined,
  search: T,
): LegacyTaskTarget<Omit<T, "task">> | null {
  if (search.task === undefined) return null;
  const { task, ...rest } = search;
  return { taskKey: taskKey ?? (task.trim() || undefined), search: rest };
}
