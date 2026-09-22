import { ChatLayout } from "@/components/chat-layout";
import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";

export default function LibraryRoute() {
  return (
    <ChatLayout.Content>
      <LibraryTab />
    </ChatLayout.Content>
  );
}
