import { ChatSidePanel } from "@/web/components/chat/side-panel-chat";
import { BlocksPanel } from "@/web/components/sandbox/blocks/blocks-panel";
import type { SidePanelKind } from "@/web/hooks/use-layout-state";

export function SidePanel({
  kind,
  virtualMcpId,
  chatContent,
}: {
  kind: SidePanelKind;
  virtualMcpId: string;
  chatContent?: React.ReactNode;
}) {
  if (kind === "blocks") {
    return (
      <div data-testid="blocks-panel-shell" className="h-full min-h-0">
        <BlocksPanel virtualMcpId={virtualMcpId} />
      </div>
    );
  }

  return (
    <div data-testid="chat-panel" className="h-full min-h-0">
      {chatContent ?? <ChatSidePanel />}
    </div>
  );
}
