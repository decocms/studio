import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
} from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useRouteDefaultMain } from "@/hooks/use-route-default-main";
import {
  resolveDefaultPanelState,
  resolveWorkspacePanelAction,
  type EntityLayoutMetadata,
  type WorkspacePanelAction,
  type WorkspaceVisibility,
} from "@/hooks/workspace-panel-state";
import { useActivePanelTabId } from "./main-panel-tabs/use-panel-navigate";
import { useRouteThreadId, useRouteVirtualMcpId } from "./thread-route";

interface PanelDefaults {
  scopeKey: string;
  mainViewType: string | null;
  chatDefaultOpen: boolean | null;
  threadHasMessages: boolean;
}

const WorkspacePanelsContext = createContext<
  | (WorkspaceVisibility & {
      sidePanelParamPresent: boolean;
      toggleMain: () => void;
      toggleSidePanel: () => void;
      setDefaults: Dispatch<SetStateAction<PanelDefaults | null>>;
    })
  | null
>(null);

function usePanelScopeKey(): string {
  const { org } = useParams({ strict: false });
  const virtualMcpId = useRouteVirtualMcpId();
  const threadId = useRouteThreadId();
  return JSON.stringify([org, virtualMcpId, threadId]);
}

/** Panel chrome survives workspace loading; URL choices always override defaults. */
export function WorkspacePanelsProvider({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const scopeKey = usePanelScopeKey();
  const routeDefaultMain = useRouteDefaultMain();
  const panelTabId = useActivePanelTabId();
  const [defaults, setDefaults] = useState<PanelDefaults | null>(null);
  const scoped = defaults?.scopeKey === scopeKey ? defaults : null;
  const visibility = resolveDefaultPanelState({
    entityMetadata: scoped
      ? {
          defaultMainView: scoped.mainViewType
            ? { type: scoped.mainViewType }
            : null,
          chatDefaultOpen: scoped.chatDefaultOpen,
        }
      : null,
    threadHasMessages: scoped?.threadHasMessages ?? false,
    mainPanelParam: search.mainpanel,
    sidePanelParamPresent: search.sidepanel !== undefined,
    sidePanelParamValue: search.sidepanel,
    routeDefaultMain,
    routeNamesView: panelTabId !== undefined,
  });

  const applyAction = (action: WorkspacePanelAction) => {
    const update = resolveWorkspacePanelAction(action, visibility);
    if (!update) return;
    navigate({
      to: ".",
      search: (previous) => ({ ...previous, ...update }),
      replace: true,
    });
  };

  return (
    <WorkspacePanelsContext
      value={{
        ...visibility,
        sidePanelParamPresent: search.sidepanel !== undefined,
        toggleMain: () => applyAction({ type: "toggleMain" }),
        toggleSidePanel: () => applyAction({ type: "toggleSidePanel" }),
        setDefaults,
      }}
    >
      {children}
    </WorkspacePanelsContext>
  );
}

export function useWorkspacePanels() {
  const context = use(WorkspacePanelsContext);
  if (!context) {
    throw new Error("Workspace panels require WorkspacePanelsProvider");
  }
  return context;
}

/** Keep only the current scope's resolved defaults when its workspace suspends. */
export function usePublishWorkspacePanelDefaults({
  entityMetadata,
  threadHasMessages,
}: {
  entityMetadata: EntityLayoutMetadata | null;
  threadHasMessages: boolean;
}) {
  const { setDefaults } = useWorkspacePanels();
  const scopeKey = usePanelScopeKey();
  const mainViewType = entityMetadata?.defaultMainView?.type ?? null;
  const chatDefaultOpen = entityMetadata?.chatDefaultOpen ?? null;

  useLayoutEffect(() => {
    setDefaults((previous) =>
      previous?.scopeKey === scopeKey &&
      previous.mainViewType === mainViewType &&
      previous.chatDefaultOpen === chatDefaultOpen &&
      previous.threadHasMessages === threadHasMessages
        ? previous
        : { scopeKey, mainViewType, chatDefaultOpen, threadHasMessages },
    );
  }, [setDefaults, scopeKey, mainViewType, chatDefaultOpen, threadHasMessages]);
}
