import type { BlogCard } from "@decocms/shared/blog-card";
import { useOpenBlogChat } from "@/hooks/use-open-blog-chat";

/** Open a card with its chat beside it, in one navigation. */
export function useOpenCardChat() {
  const openChat = useOpenBlogChat();
  return (card: Pick<BlogCard, "id" | "threadId">) => {
    if (!card.threadId) return;
    openChat(card.threadId, { track: "content", card: card.id });
  };
}
