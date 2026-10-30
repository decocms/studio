import { useNavigate } from "@tanstack/react-router";
import { useScopeId } from "@/hooks/use-project-scope";
import { useProjectContext } from "@/sdk";

/** Where the page lands beside the chat: the content track, one of its views, a card. */
interface BlogChatLayout {
  track?: "content";
  view?: "campaigns";
  card?: string;
}

/**
 * Open one of the content track's chats beside the page, in one navigation.
 * The chat belongs to the organization's Super Agent, so a project's page
 * hands over to the organization's Execute, where that chat can open.
 */
export function useOpenBlogChat() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const scopeId = useScopeId();

  return (threadId: string, layout: BlogChatLayout = {}) => {
    const search = { ...layout, thread: threadId, sidepanel: true };
    if (scopeId) {
      void navigate({
        to: "/$org/tasks/{-$taskKey}",
        params: { org: org.slug, taskKey: undefined },
        search: { ...search, track: "content" as const },
      });
      return;
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...search }),
    });
  };
}
