import { createContext, use, type PropsWithChildren } from "react";
import {
  type MainPanelTabs,
  useMainPanelTabsState,
} from "./use-main-panel-tabs";

const MainPanelTabsContext = createContext<MainPanelTabs | null>(null);

export function MainPanelTabsProvider({
  children,
  virtualMcpId,
  taskId,
}: PropsWithChildren<{
  virtualMcpId: string;
  taskId: string | null;
}>) {
  const value = useMainPanelTabsState({ virtualMcpId, taskId });

  return <MainPanelTabsContext value={value}>{children}</MainPanelTabsContext>;
}

export function useMainPanelTabs(): MainPanelTabs {
  const value = use(MainPanelTabsContext);
  if (!value) {
    throw new Error(
      "useMainPanelTabs must be used within a MainPanelTabsProvider",
    );
  }
  return value;
}
