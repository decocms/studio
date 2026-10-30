import { useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import {
  ContextShell,
  projectSettingsSection,
} from "@/layouts/context/context-shell";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import type { ContextSection } from "@/lib/legacy-workspace-search";
import { VirtualMcpDetailView } from "@/views/virtual-mcp";

/** A project's settings: General, Repository and CMS, beside — not inside —
 *  its Context, which keeps only what the project's agents know. */
export default function AgentSettingsRoute() {
  const projectFirstNav = useProjectFirstNav();
  const virtualMcpId = useRouteVirtualMcpId();
  const { section } = useSearch({ strict: false }) as {
    section?: ContextSection;
  };
  if (!projectFirstNav) {
    return (
      <ChatLayout.Content>
        <SettingsTab virtualMcpId={virtualMcpId} />
      </ChatLayout.Content>
    );
  }
  const current = projectSettingsSection(section);
  return (
    <ChatLayout.Content>
      <ContextShell scope="projectSettings" section={current}>
        {virtualMcpId && (
          <VirtualMcpDetailView
            virtualMcpId={virtualMcpId}
            contextSection={current}
          />
        )}
      </ContextShell>
    </ChatLayout.Content>
  );
}
