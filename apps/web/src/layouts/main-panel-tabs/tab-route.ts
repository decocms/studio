/**
 * Canonical route owned by a main-view tab.
 *
 * Tab ids remain the in-memory vocabulary shared by thread layout state and
 * the view switcher. URLs are a different concern: every view is represented
 * by the route that owns its layout, and agent identity always lives in the
 * `/$org/agents/$agentId` path. This module is the single pure boundary
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
import { AGENT_ROUTE, DESTINATION_ROUTE } from "@/hooks/use-destination-route";
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
  | { kind: "org-destination"; destination: OrgTabDestination };

export type OrgTabDestination =
  | "home"
  | "tasks"
  | "reports"
  | "library"
  | "discover";

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
  | { to: typeof DESTINATION_ROUTE.discover; params: OrgParams; search: {} }
  | { to: typeof AGENT_ROUTE.root; params: AgentParams; search: {} }
  | { to: typeof AGENT_ROUTE.siteEditor; params: AgentParams; search: {} }
  | {
      to: typeof AGENT_ROUTE.siteEditorContent;
      params: AgentParams;
      search: {};
    }
  | {
      to: typeof AGENT_ROUTE.siteEditorCode;
      params: AgentParams;
      search: { file?: string };
    }
  | {
      to:
        | typeof AGENT_ROUTE.settings
        | typeof AGENT_ROUTE.assets
        | typeof AGENT_ROUTE.git
        | typeof AGENT_ROUTE.hosting
        | typeof AGENT_ROUTE.e2e
        | typeof AGENT_ROUTE.analytics
        | typeof AGENT_ROUTE.monitor;
      params: AgentParams;
      search: {};
    }
  | { to: typeof AGENT_ROUTE.automations; params: AgentParams; search: {} }
  | {
      to: typeof AGENT_ROUTE.automation;
      params: AgentParams & { automationId: string };
      search: {};
    }
  | {
      to: typeof AGENT_ROUTE.app;
      params: AgentParams & { connectionId: string; toolName: string };
      search: {};
    }
  | {
      to: typeof AGENT_ROUTE.view;
      params: AgentParams & { viewId: string };
      search: {};
    }
  | {
      to: typeof AGENT_ROUTE.outputFile;
      params: AgentParams;
      search: { key: string };
    }
  | {
      to: typeof AGENT_ROUTE.outputDeck;
      params: AgentParams;
      search: { path: string };
    }
  | {
      to: typeof AGENT_ROUTE.libraryFile;
      params: AgentParams;
      search: { path: string };
    }
  | {
      to: typeof AGENT_ROUTE.connectSources;
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
  board: "tasks",
  files: "library",
  reports: "reports",
  discover: "discover",
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
}): TabRouteTarget {
  const { org, agentId } = input;
  const params = { org, agentId };
  const location = tabRouteLocation(input.tabId);

  switch (location.kind) {
    case "org-destination": {
      switch (location.destination) {
        case "home":
          return { to: DESTINATION_ROUTE.home, params: { org }, search: {} };
        case "tasks":
          return {
            to: DESTINATION_ROUTE.tasks,
            params: { org, taskKey: undefined },
            search: {},
          };
        case "reports":
          return { to: DESTINATION_ROUTE.reports, params: { org }, search: {} };
        case "library":
          return { to: DESTINATION_ROUTE.library, params: { org }, search: {} };
        case "discover":
          return {
            to: DESTINATION_ROUTE.discover,
            params: { org },
            search: {},
          };
      }
    }
    case "agent-overview":
      return { to: AGENT_ROUTE.root, params, search: {} };
    case "site-editor":
      if (location.view === "content") {
        return { to: AGENT_ROUTE.siteEditorContent, params, search: {} };
      }
      if (location.view === "code") {
        return {
          to: AGENT_ROUTE.siteEditorCode,
          params,
          search: { file: location.file },
        };
      }
      return { to: AGENT_ROUTE.siteEditor, params, search: {} };
    case "agent-section":
      return { to: AGENT_ROUTE[location.section], params, search: {} };
    case "automations":
      return location.automationId
        ? {
            to: AGENT_ROUTE.automation,
            params: { ...params, automationId: location.automationId },
            search: {},
          }
        : { to: AGENT_ROUTE.automations, params, search: {} };
    case "app":
      return {
        to: AGENT_ROUTE.app,
        params: {
          ...params,
          connectionId: location.connectionId,
          toolName: location.toolName,
        },
        search: {},
      };
    case "agent-view":
      return {
        to: AGENT_ROUTE.view,
        params: { ...params, viewId: location.viewId },
        search: {},
      };
    case "output-file":
      return {
        to: AGENT_ROUTE.outputFile,
        params,
        search: { key: location.key },
      };
    case "output-deck":
      return {
        to: AGENT_ROUTE.outputDeck,
        params,
        search: { path: location.path },
      };
    case "library-file":
      return {
        to: AGENT_ROUTE.libraryFile,
        params,
        search: { path: location.path },
      };
    case "connect-sources":
      return { to: AGENT_ROUTE.connectSources, params, search: {} };
  }
}

/**
 * Resolve the canonical page that owns a selected thread.
 *
 * Organization Home owns the no-agent destination and the Super Agent's
 * overview/default chat. Explicit Super Agent views still use its
 * `/agents/$agentId/...` workspace, exactly like any other agent.
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
    case DESTINATION_ROUTE.discover:
      navigate({
        to: DESTINATION_ROUTE.discover,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.root:
      navigate({
        to: AGENT_ROUTE.root,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.siteEditor:
      navigate({
        to: AGENT_ROUTE.siteEditor,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.siteEditorContent:
      navigate({
        to: AGENT_ROUTE.siteEditorContent,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.siteEditorCode:
      navigate({
        to: AGENT_ROUTE.siteEditorCode,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.automations:
      navigate({
        to: AGENT_ROUTE.automations,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.automation:
      navigate({
        to: AGENT_ROUTE.automation,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.app:
      navigate({
        to: AGENT_ROUTE.app,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.view:
      navigate({
        to: AGENT_ROUTE.view,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.outputFile:
      navigate({
        to: AGENT_ROUTE.outputFile,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.outputDeck:
      navigate({
        to: AGENT_ROUTE.outputDeck,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.libraryFile:
      navigate({
        to: AGENT_ROUTE.libraryFile,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.connectSources:
      navigate({
        to: AGENT_ROUTE.connectSources,
        params: target.params,
        search,
        replace,
      });
      return;
    case AGENT_ROUTE.settings:
    case AGENT_ROUTE.assets:
    case AGENT_ROUTE.git:
    case AGENT_ROUTE.hosting:
    case AGENT_ROUTE.e2e:
    case AGENT_ROUTE.analytics:
    case AGENT_ROUTE.monitor:
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
