import { useNavigate } from "@tanstack/react-router";
import type { BlogCard } from "@decocms/shared/blog-card";
import { useScopeId } from "@/hooks/use-project-scope";
import { useProjectContext } from "@/sdk";

/**
 * Open a card with its chat beside it, in one navigation. The chat belongs to
 * the organization's Super Agent, so a project's Execute hands over to the
 * organization's, where that chat can open.
 */
export function useOpenCardChat() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const scopeId = useScopeId();

  return (card: Pick<BlogCard, "id" | "threadId">) => {
    if (!card.threadId) return;
    const layout = {
      track: "content" as const,
      card: card.id,
      thread: card.threadId,
      sidepanel: true,
    };
    if (scopeId) {
      void navigate({
        to: "/$org/tasks/{-$taskKey}",
        params: { org: org.slug, taskKey: undefined },
        search: layout,
      });
      return;
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...layout }),
    });
  };
}
