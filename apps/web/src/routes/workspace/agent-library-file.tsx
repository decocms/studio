import { ChatLayout } from "@/components/chat-layout";
import { useSearch } from "@tanstack/react-router";
import { LibraryFileTab } from "@/layouts/main-panel-tabs/library-file-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentLibraryFileContent() {
  const search = useSearch({ strict: false });
  const virtualMcpId = useRouteVirtualMcpId();
  const value =
    "path" in search && typeof search.path === "string"
      ? search.path
      : undefined;
  return value ? (
    <LibraryFileTab key={value} path={value} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}

export default function AgentLibraryFileRoute() {
  return (
    <ChatLayout.Content>
      <AgentLibraryFileContent />
    </ChatLayout.Content>
  );
}
