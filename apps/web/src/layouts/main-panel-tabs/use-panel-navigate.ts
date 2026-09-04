/** Route-native navigation for the workspace's main views. */

import {
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useScopeId } from "@/hooks/use-project-scope";
import {
  navigateToTabLocation,
  tabIdForRoute,
  tabRouteLocation,
  type TabRouteSearchWriter,
} from "./tab-route";
import { resolvePanelNavigationSearch } from "./panel-navigation-search";

/** The semantic view owned by the deepest matched route. */
function useMatchedMainView(): {
  mainView: string | undefined;
  siteEditorView: "preview" | "content" | "code" | undefined;
} {
  return useRouterState({
    structuralSharing: true,
    select: (state) => {
      for (let i = state.matches.length - 1; i >= 0; i--) {
        const data = state.matches[i]?.staticData;
        if (data?.mainView || data?.siteEditorView) {
          return {
            mainView: data.mainView,
            siteEditorView: data.siteEditorView,
          };
        }
      }
      return { mainView: undefined, siteEditorView: undefined };
    },
  });
}

/** The view the canonical route names, represented in the tab-id vocabulary. */
export function useActivePanelTabId(): string | undefined {
  const params = useParams({ strict: false });
  const routeSearch = useSearch({ strict: false });
  const search = {
    file:
      "file" in routeSearch && typeof routeSearch.file === "string"
        ? routeSearch.file
        : undefined,
    key:
      "key" in routeSearch && typeof routeSearch.key === "string"
        ? routeSearch.key
        : undefined,
    path:
      "path" in routeSearch && typeof routeSearch.path === "string"
        ? routeSearch.path
        : undefined,
  };
  const { mainView, siteEditorView } = useMatchedMainView();

  return tabIdForRoute({ mainView, siteEditorView, params, search });
}

export interface OpenPanelOptions {
  /** Defaults to `true`: swapping the view is a layout write. */
  replace?: boolean;
  /** Route the view to another agent. */
  agentId?: string;
  /** Extra route-owned search applied before the view's own payload. */
  search?: (prev: Record<string, unknown>) => Record<string, unknown>;
}

export function usePanelNavigate(): {
  openPanel: (tabId: string, opts?: OpenPanelOptions) => void;
  closePanel: (opts?: { replace?: boolean }) => void;
} {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const routeAgentId = useRouteVirtualMcpId();
  const routeProjectId = useScopeId();
  const org = params.org ?? "";

  const openPanel = (tabId: string, opts?: OpenPanelOptions) => {
    const location = tabRouteLocation(tabId);
    const destinationScope =
      opts?.agentId !== undefined || routeProjectId !== null
        ? "project"
        : "organization";
    const orgDestination =
      location.kind === "org-destination" ||
      (location.kind === "project-destination" &&
        destinationScope === "organization");
    const search: TabRouteSearchWriter = (prev) =>
      resolvePanelNavigationSearch({
        previous: prev,
        destination: orgDestination ? "organization" : "agent",
        update: opts?.search,
      });
    navigateToTabLocation(navigate, {
      org,
      agentId: opts?.agentId ?? routeAgentId,
      tabId,
      destinationScope,
      search,
      replace: opts?.replace ?? true,
    });
  };

  const closePanel = (opts?: { replace?: boolean }) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        mainpanel: false,
      }),
      replace: opts?.replace ?? true,
    });

  return { openPanel, closePanel };
}
