/** The organization's home: Today's daily brief. */

import { ChatLayout } from "@/components/chat-layout";
import { TodayPage } from "@/components/org-home/today-page";

export default function HomeRoute() {
  return (
    <ChatLayout.Content>
      <TodayPage />
    </ChatLayout.Content>
  );
}
