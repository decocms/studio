import type { PropsWithChildren } from "react";
import { MainPanelTabsContext } from "./main-panel-tabs-context";
import { useMainPanelTabsState } from "./use-main-panel-tabs";

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
