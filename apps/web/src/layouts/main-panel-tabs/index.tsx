/** The route outlet inside the existing main panel and its recovery boundary. */
import { Outlet } from "@tanstack/react-router";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { ErrorBoundary } from "@/components/error-boundary";
import { useActivePanelTabId } from "./use-panel-navigate";

function RouteBody({ activeTab }: { activeTab: string }) {
  if (
    (import.meta.env.DEV || __E2E_TEST_HOOKS__) &&
    typeof window !== "undefined" &&
    "__forceTabError" in window &&
    window.__forceTabError === activeTab
  ) {
    throw new Error(`forced tab error: ${activeTab}`);
  }
  return <Outlet />;
}

export function MainPanelContent() {
  const activeTab = useActivePanelTabId() ?? "overview";
  return (
    <ErrorBoundary key={activeTab}>
      <MainPanelBoundary>
        <RouteBody activeTab={activeTab} />
      </MainPanelBoundary>
    </ErrorBoundary>
  );
}
