import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { useSearch } from "@tanstack/react-router";
import { DeckTab } from "@/layouts/main-panel-tabs/deck-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentDeckContent() {
  const search = useSearch({ strict: false });
  const virtualMcpId = useRouteVirtualMcpId();
  const value =
    "path" in search && typeof search.path === "string"
      ? search.path
      : undefined;
  return value ? (
    <DeckTab key={value} path={value} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}

export default function AgentDeckPage() {
  return (
    <WorkspacePage>
      <AgentDeckContent />
    </WorkspacePage>
  );
}
