/**
 * Canonical route owned by a main-view tab.
 *
 * Tab ids remain the in-memory vocabulary shared by thread layout state and
 * the view switcher. URLs are a different concern: every view is represented
 * by the route that owns its layout, and project identity always lives in the
 * `/$org/projects/$agentId` path. This module is the single pure boundary
 * between those two vocabularies.
 */

import {
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatAgentViewTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
  isLegacySettingsTab,
  normalizePanelSegment,
  parseAutomationTabId,
  parseAgentViewTabId,
  parseCodeTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  parsePinnedViewTabId,
} from "./tab-id";
import {
  PROJECT_ROUTE,
  DESTINATION_ROUTE,
} from "@/hooks/use-destination-route";
import type { useNavigate } from "@tanstack/react-router";

export type TabRouteLocation =
  | { kind: "agent-overview" }
  | { kind: "site-editor"; view: "preview" | "content"; file?: never }
  | { kind: "site-editor"; view: "code"; file?: string }
  | {
      kind: "agent-section";
      section:
        | "settings"
        | "assets"
        | "git"
        | "hosting"
        | "e2e"
        | "analytics"
        | "monitor";
    }
  | { kind: "automations"; automationId?: string }
  | { kind: "app"; connectionId: string; toolName: string }
  | { kind: "agent-view"; viewId: string }
  | { kind: "output-file"; key: string }
  | { kind: "output-deck"; path: string }
  | { kind: "library-file"; path: string }
  | { kind: "connect-sources" }
  | { kind: "project-destination"; destination: ProjectTabDestination }
  | { kind: "org-destination"; destination: OrgTabDestination };

export type ProjectTabDestination = "tasks" | "reports";
export type OrgTabDestination = "home" | "library";

type AgentParams = { org: string; agentId: string };
type OrgParams = { org: string };

/** A navigation-ready canonical target. `search` contains only payload owned
 * by the destination route; callers layer shared layout keys over it. */
export type TabRouteTarget =
  | { to: typeof DESTINATION_ROUTE.home; params: OrgParams; search: {} }
  | {
      to: typeof DESTINATION_ROUTE.tasks;
      params: OrgParams & { taskKey: undefined };
      search: {};
    }
  | { to: typeof DESTINATION_ROUTE.reports; params: OrgParams; search: {} }
  | { to: typeof DESTINATION_ROUTE.library; params: OrgParams; search: {} }
  | { to: typeof PROJECT_ROUTE.root; params: AgentParams; search: {} }
  | {
      to: typeof PROJECT_ROUTE.tasks;
      params: AgentParams & { taskKey: undefined };
      search: {};
    }
  | { to: typeof PROJECT_ROUTE.reports; params: AgentParams; search: {} }
  | { to: typeof PROJECT_ROUTE.siteEditor; params: AgentParams; search: {} }
  | {
      to: typeof PROJECT_ROUTE.siteEditorContent;
      params: AgentParams;
      search: {};
    }
  | {
      to: typeof PROJECT_ROUTE.siteEditorCode;
      params: AgentParams;
      search: { file?: string };
    }
  | {
      to:
        | typeof PROJECT_ROUTE.settings
        | typeof PROJECT_ROUTE.assets
        | typeof PROJECT_ROUTE.git
        | typeof PROJECT_ROUTE.hosting
        | typeof PROJECT_ROUTE.e2e
        | typeof PROJECT_ROUTE.analytics
        | typeof PROJECT_ROUTE.monitor;
      params: AgentParams;
      search: {};
    }
  | { to: typeof PROJECT_ROUTE.automations; params: AgentParams; search: {} }
  | {
      to: typeof PROJECT_ROUTE.automation;
      params: AgentParams & { automationId: string };
      search: {};
    }
  | {
      to: typeof PROJECT_ROUTE.app;
      params: AgentParams & { connectionId: string; toolName: string };
      search: {};
    }
  | {
      to: typeof PROJECT_ROUTE.view;
      params: AgentParams & { viewId: string };
      search: {};
    }
  | {
      to: typeof PROJECT_ROUTE.outputFile;
      params: AgentParams;
      search: { key: string };
    }
  | {
      to: typeof PROJECT_ROUTE.outputDeck;
      params: AgentParams;
      search: { path: string };
    }
  | {
      to: typeof PROJECT_ROUTE.libraryFile;
      params: AgentParams;
      search: { path: string };
    }
  | {
      to: typeof PROJECT_ROUTE.connectSources;
      params: AgentParams;
      search: {};
    };

type Navigate = ReturnType<typeof useNavigate>;
export type TabRouteSearchWriter = (
  prev: Record<string, unknown>,
) => Record<string, unknown>;

export interface NavigateToTabLocationOptions {
  tabId: string;
  org: string;
  agentId: string;
  /** Tasks and Reports exist at both organization and project scope. */
  destinationScope?: "organization" | "project";
  /** Shared route search (thread/layout state). The target's own payload is
   * applied last, so a caller cannot accidentally overwrite its identity. */
  search?: TabRouteSearchWriter;
  replace?: boolean;
}

export interface NavigateToTabRouteTargetOptions {
  /** Shared route search (thread/layout state). The target's own payload is
   * applied last, so a caller cannot accidentally overwrite it. */
  search?: TabRouteSearchWriter;
  replace?: boolean;
}

export interface MatchedTabRouteState {
  mainView?: string;
  siteEditorView?: "preview" | "content" | "code";
  params?: {
    automationId?: string;
    connectionId?: string;
    toolName?: string;
    viewId?: string;
  };
  search?: { file?: string; key?: string; path?: string };
}

/** Reconstruct the in-memory tab id from typed route metadata and params. */
export function tabIdForRoute(state: MatchedTabRouteState): string | undefined {
  const params = state.params ?? {};
  const search = state.search ?? {};

  if (state.siteEditorView === "content") return "content";
  if (state.siteEditorView === "code") {
    return search.file ? formatCodeTabId(search.file) : "code";
  }
  if (state.siteEditorView === "preview") return "site-editor";

  switch (state.mainView) {
    case "automation":
      return params.automationId
        ? `automation:${params.automationId}`
        : "automations";
    case "app":
      return params.connectionId && params.toolName
        ? formatPinnedViewTabId(params.connectionId, params.toolName)
        : undefined;
    case "view":
      return params.viewId ? formatAgentViewTabId(params.viewId) : undefined;
    case "file":
      return search.key ? formatFileTabId(search.key) : undefined;
    case "deck":
      return search.path ? formatDeckTabId(search.path) : undefined;
    case "library-file":
      return search.path ? formatLibraryFileTabId(search.path) : undefined;
    default:
      return state.mainView;
  }
}

const ORG_DESTINATION_BY_TAB: Readonly<Record<string, OrgTabDestination>> = {
  files: "library",
  // Compatibility for persisted tabs written while Discover was a destination.
  discover: "home",
};

const PROJECT_DESTINATION_BY_TAB: Readonly<
  Record<string, ProjectTabDestination>
> = {
  board: "tasks",
  reports: "reports",
};

const AGENT_SECTION_BY_TAB: Readonly<
  Record<
    string,
    Extract<TabRouteLocation, { kind: "agent-section" }>["section"]
  >
> = {
  settings: "settings",
  assets: "assets",
  git: "git",
  hosting: "hosting",
  e2e: "e2e",
  analytics: "analytics",
  cdn: "monitor",
};

/**
 * Resolve a tab id to the route that owns it.
 *
 * Unknown ids are agent-declared views. They deliberately receive their own
 * `/views/$viewId` namespace, so a future built-in route cannot collide with
 * an existing project's metadata.
 */
export function tabRouteLocation(tabId: string): TabRouteLocation {
  const agentView = parseAgentViewTabId(tabId);
  if (agentView) {
    return { kind: "agent-view", viewId: agentView.id };
  }

  const pinned = parsePinnedViewTabId(tabId);
  if (pinned) {
    return {
      kind: "app",
      connectionId: pinned.connectionId,
      toolName: pinned.toolName,
    };
  }

  const automation = parseAutomationTabId(tabId);
  if (automation) {
    return { kind: "automations", automationId: automation.id };
  }

  const file = parseFileTabId(tabId);
  if (file) return { kind: "output-file", key: file.key };

  const deck = parseDeckTabId(tabId);
  if (deck) return { kind: "output-deck", path: deck.path };

  const libraryFile = parseLibraryFileTabId(tabId);
  if (libraryFile) return { kind: "library-file", path: libraryFile.path };

  const code = parseCodeTabId(tabId);
  if (code) {
    return {
      kind: "site-editor",
      view: "code",
      ...(code.path ? { file: code.path } : {}),
    };
  }

  if (isLegacySettingsTab(tabId)) {
    return { kind: "agent-section", section: "settings" };
  }

  const normalized = normalizePanelSegment(tabId);
  if (normalized === "overview") return { kind: "agent-overview" };
  if (normalized === "site-editor") {
    return { kind: "site-editor", view: "preview" };
  }
  if (normalized === "content") {
    return { kind: "site-editor", view: "content" };
  }
  if (normalized === "automations") return { kind: "automations" };
  if (normalized === "connect-sources") return { kind: "connect-sources" };

  const projectDestination = PROJECT_DESTINATION_BY_TAB[normalized];
  if (projectDestination) {
    return { kind: "project-destination", destination: projectDestination };
  }

  const destination = ORG_DESTINATION_BY_TAB[normalized];
  if (destination) return { kind: "org-destination", destination };

  const section = AGENT_SECTION_BY_TAB[normalized];
  if (section) return { kind: "agent-section", section };

  return { kind: "agent-view", viewId: normalized };
}

/** Resolve a tab id all the way to its canonical route and params. */
export function tabRouteTarget(input: {
  tabId: string;
  org: string;
  agentId: string;
  destinationScope?: "organization" | "project";
}): TabRouteTarget {
  const { org, agentId } = input;
  const params = { org, agentId };
  const location = tabRouteLocation(input.tabId);

  switch (location.kind) {
    case "project-destination":
      if (input.destinationScope === "organization") {
        return location.destination === "tasks"
          ? {
              to: DESTINATION_ROUTE.tasks,
              params: { org, taskKey: undefined },
              search: {},
            }
          : { to: DESTINATION_ROUTE.reports, params: { org }, search: {} };
      }
      return location.destination === "tasks"
        ? {
            to: PROJECT_ROUTE.tasks,
            params: { ...params, taskKey: undefined },
            search: {},
          }
        : { to: PROJECT_ROUTE.reports, params, search: {} };
    case "org-destination": {
      switch (location.destination) {
        case "home":
          return { to: DESTINATION_ROUTE.home, params: { org }, search: {} };
        case "library":
          return { to: DESTINATION_ROUTE.library, params: { org }, search: {} };
      }
    }
    case "agent-overview":
      return { to: PROJECT_ROUTE.root, params, search: {} };
    case "site-editor":
      if (location.view === "content") {
        return { to: PROJECT_ROUTE.siteEditorContent, params, search: {} };
      }
      if (location.view === "code") {
        return {
          to: PROJECT_ROUTE.siteEditorCode,
          params,
          search: { file: location.file },
        };
      }
      return { to: PROJECT_ROUTE.siteEditor, params, search: {} };
    case "agent-section":
      return { to: PROJECT_ROUTE[location.section], params, search: {} };
    case "automations":
      return location.automationId
        ? {
            to: PROJECT_ROUTE.automation,
            params: { ...params, automationId: location.automationId },
            search: {},
          }
        : { to: PROJECT_ROUTE.automations, params, search: {} };
    case "app":
      return {
        to: PROJECT_ROUTE.app,
        params: {
          ...params,
          connectionId: location.connectionId,
          toolName: location.toolName,
        },
        search: {},
      };
    case "agent-view":
      return {
        to: PROJECT_ROUTE.view,
        params: { ...params, viewId: location.viewId },
        search: {},
      };
    case "output-file":
      return {
        to: PROJECT_ROUTE.outputFile,
        params,
        search: { key: location.key },
      };
    case "output-deck":
      return {
        to: PROJECT_ROUTE.outputDeck,
        params,
        search: { path: location.path },
      };
    case "library-file":
      return {
        to: PROJECT_ROUTE.libraryFile,
        params,
        search: { path: location.path },
      };
    case "connect-sources":
      return { to: PROJECT_ROUTE.connectSources, params, search: {} };
  }
}

/**
 * Resolve the canonical page that owns a selected thread.
 *
 * Organization Home owns the no-agent destination and the Super Agent's
 * overview/default chat. Explicit Super Agent views still use its
 * `/projects/$agentId/...` workspace, exactly like any other agent.
 */
export function canonicalThreadRouteTarget(input: {
  org: string;
  agentId?: string;
  superAgentId: string;
  tabId?: string;
}): TabRouteTarget {
  if (
    !input.agentId ||
    (input.agentId === input.superAgentId &&
      (input.tabId === undefined || input.tabId === "overview"))
  ) {
    return {
      to: DESTINATION_ROUTE.home,
      params: { org: input.org },
      search: {},
    };
  }
  const tabId = input.tabId ?? "overview";
  const safeTabId =
    input.agentId !== input.superAgentId &&
    tabRouteLocation(tabId).kind === "org-destination"
      ? "overview"
      : tabId;
  return tabRouteTarget({
    org: input.org,
    agentId: input.agentId,
    tabId: safeTabId,
    destinationScope:
      input.agentId === input.superAgentId ? "organization" : "project",
  });
}

/**
 * Navigate to an already-resolved canonical tab target.
 *
 * Keeping the exhaustive typed executor beside {@link tabRouteTarget} lets
 * panel, chat, thread and compatibility navigation share one route switch.
 */
export function navigateToTabRouteTarget(
  navigate: Navigate,
  target: TabRouteTarget,
  options: NavigateToTabRouteTargetOptions = {},
): void {
  const search = (prev: Record<string, unknown>) => ({
    ...(options.search?.(prev) ?? {}),
    ...target.search,
  });
  const replace = options.replace ?? true;

  switch (target.to) {
    case DESTINATION_ROUTE.tasks:
      navigate({
        to: DESTINATION_ROUTE.tasks,
        params: target.params,
        search,
        replace,
      });
      return;
    case DESTINATION_ROUTE.home:
      navigate({
        to: DESTINATION_ROUTE.home,
        params: target.params,
        search,
        replace,
      });
      return;
    case DESTINATION_ROUTE.reports:
      navigate({
        to: DESTINATION_ROUTE.reports,
        params: target.params,
        search,
        replace,
      });
      return;
    case DESTINATION_ROUTE.library:
      navigate({
        to: DESTINATION_ROUTE.library,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.root:
      navigate({
        to: PROJECT_ROUTE.root,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.tasks:
      navigate({
        to: PROJECT_ROUTE.tasks,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.reports:
      navigate({
        to: PROJECT_ROUTE.reports,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.siteEditor:
      navigate({
        to: PROJECT_ROUTE.siteEditor,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.siteEditorContent:
      navigate({
        to: PROJECT_ROUTE.siteEditorContent,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.siteEditorCode:
      navigate({
        to: PROJECT_ROUTE.siteEditorCode,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.automations:
      navigate({
        to: PROJECT_ROUTE.automations,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.automation:
      navigate({
        to: PROJECT_ROUTE.automation,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.app:
      navigate({
        to: PROJECT_ROUTE.app,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.view:
      navigate({
        to: PROJECT_ROUTE.view,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.outputFile:
      navigate({
        to: PROJECT_ROUTE.outputFile,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.outputDeck:
      navigate({
        to: PROJECT_ROUTE.outputDeck,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.libraryFile:
      navigate({
        to: PROJECT_ROUTE.libraryFile,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.connectSources:
      navigate({
        to: PROJECT_ROUTE.connectSources,
        params: target.params,
        search,
        replace,
      });
      return;
    case PROJECT_ROUTE.settings:
    case PROJECT_ROUTE.assets:
    case PROJECT_ROUTE.git:
    case PROJECT_ROUTE.hosting:
    case PROJECT_ROUTE.e2e:
    case PROJECT_ROUTE.analytics:
    case PROJECT_ROUTE.monitor:
      navigate({
        to: target.to,
        params: target.params,
        search,
        replace,
      });
  }
}

/** Resolve a tab id and navigate through the canonical target executor. */
export function navigateToTabLocation(
  navigate: Navigate,
  options: NavigateToTabLocationOptions,
): void {
  navigateToTabRouteTarget(navigate, tabRouteTarget(options), options);
}
