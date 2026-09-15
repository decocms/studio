import { Outlet, useSearch } from "@tanstack/react-router";
import { ChatPrefsProvider } from "@/components/chat/context";
import { ThreadManagerProvider } from "@/components/chat/store/hooks";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { ReportsConnectModal } from "@/routes/reports-onboarding/connect-modal";

/** Thread providers load only for destinations that offer a conversation. */
export default function ThreadRoute() {
  const search = useSearch({ strict: false });
  // Commerce onboarding hands off with ?connect=1 until a source is connected.
  const showConnectModal = "connect" in search && search.connect === "1";
  const siteUrl =
    "siteUrl" in search && typeof search.siteUrl === "string"
      ? search.siteUrl
      : undefined;

  return (
    <ThreadManagerProvider>
      <ChatPrefsProvider>
        <MainPanelBoundary>
          <Outlet />
        </MainPanelBoundary>
        {showConnectModal && <ReportsConnectModal siteUrl={siteUrl} />}
      </ChatPrefsProvider>
    </ThreadManagerProvider>
  );
}
