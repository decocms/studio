import { toast } from "sonner";
import { useAskInChat } from "@/hooks/use-ask-in-chat";
import { useBlogAi } from "@/hooks/use-blog-ai";
import { useOpenBlogChat } from "@/hooks/use-open-blog-chat";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * Ask for a brand guide fill. With the blog on it runs in a chat of its own,
 * one that may read the store's connections, opened beside the page; with it
 * off it goes to the chat beside the page, like any other request.
 */
export function useBrandFill() {
  const t = useT();
  const ask = useAskInChat();
  const blogAi = useBlogAi();
  const studio = useStudioTools();
  const openChat = useOpenBlogChat();

  return async (prompt: string) => {
    if (!blogAi) {
      ask(prompt);
      return;
    }
    try {
      const { threadId } = await studio.call("BLOG_BRAND_FILL", { prompt });
      openChat(threadId);
    } catch (err) {
      toast.error(
        t("library.context.fillFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };
}
