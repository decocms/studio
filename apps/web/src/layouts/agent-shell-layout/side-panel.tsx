import { ChatSidePanel } from "@/components/chat/side-panel-chat";

export function SidePanel({ chatContent }: { chatContent?: React.ReactNode }) {
  return (
    <div data-testid="chat-panel" className="h-full min-h-0">
      {chatContent ?? <ChatSidePanel />}
    </div>
  );
}
