/** Compact new-chat action shared by workspace chrome. */
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { Edit05 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { useT } from "@/i18n/use-t.ts";

/**
 * New-chat button — starts a fresh chat with the active agent (reusing an
 * existing empty "New chat" for it when there is one, so empties don't pile
 * up). It stays available in compact workspace chrome so "new chat" remains
 * reachable when the sidebar's own action is tucked away.
 */
export function NewChatCrumb() {
  const t = useT();
  const { threads } = useThreads();
  const { createNewTask } = usePanelActions();

  /**
   * The agent named by the canonical workspace route. A new chat started there
   * belongs to that agent rather than to the Super Agent.
   */
  const activeAgentId = useRouteVirtualMcpId();
  const routeThreadId = useRouteThreadId();

  /** A new chat inherits the viewed thread's branch so it lands on the same
   *  sandbox; `null` where the route names no thread → server default. */
  const currentBranch =
    threads.find((thread) => thread.id === routeThreadId)?.branch ?? null;

  // ALWAYS create a fresh chat — never reuse/refocus an existing empty one.
  const handleNewChat = () => {
    void createNewTask(activeAgentId, currentBranch);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleNewChat}
          aria-label={t("sidebar.taskGroupsList.newChat")}
          className="flex shrink-0 items-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Edit05 size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t("sidebar.taskGroupsList.newChat")}
      </TooltipContent>
    </Tooltip>
  );
}
