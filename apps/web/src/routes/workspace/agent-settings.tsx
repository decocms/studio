import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { isProjectSettingsSectionKey } from "@/views/virtual-mcp/settings/sections";

function AgentSettingsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

export default function AgentSettingsRoute() {
  const projectFirstNav = useProjectFirstNav();
  const { org, agentId } = useParams({ strict: false });
  const { section } = useSearch({ strict: false });
  /* Under project-first nav a project's settings are sections of its Context. */
  if (projectFirstNav && org && agentId) {
    return (
      <Navigate
        to={PROJECT_ROUTE.library}
        params={{ org, agentId }}
        search={{
          section: isProjectSettingsSectionKey(section) ? section : "general",
        }}
        replace
      />
    );
  }
  return (
    <ChatLayout.Content>
      <AgentSettingsContent />
    </ChatLayout.Content>
  );
}
