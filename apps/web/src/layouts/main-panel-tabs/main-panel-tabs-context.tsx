import { createContext, use } from "react";
import type { MainPanelTabs } from "./use-main-panel-tabs";

export const MainPanelTabsContext = createContext<MainPanelTabs | null>(null);

export function useMainPanelTabs(): MainPanelTabs {
  const value = use(MainPanelTabsContext);
  if (!value) {
    throw new Error(
      "useMainPanelTabs must be used within a MainPanelTabsProvider",
    );
  }
  return value;
}
