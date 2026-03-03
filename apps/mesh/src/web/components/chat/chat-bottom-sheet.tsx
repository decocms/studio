import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { Sheet, SheetContent } from "@deco/ui/components/sheet.tsx";
import { ChatPanel } from "./side-panel-chat";

export function ChatBottomSheet() {
  const [isChatOpen, setChatOpen] = useDecoChatOpen();

  return (
    <Sheet open={isChatOpen} onOpenChange={setChatOpen}>
      <SheetContent
        side="bottom"
        className="h-[calc(100svh-1.25rem)] p-0 rounded-t-xl border-0"
        hideCloseButton
      >
        <ChatPanel />
      </SheetContent>
    </Sheet>
  );
}
