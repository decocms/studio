/**
 * The new-chat crumb, which is what is left of this file: the agent crumb and
 * its picker lived here too, until the mobile sheet — their only caller —
 * stopped carrying an agent selector beside the org one.
 */
import { Edit05 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { useT } from "@/i18n/use-t.ts";

/**
 * New-chat button — starts a fresh chat with the active agent (reusing an
 * existing empty "New chat" for it when there is one, so empties don't pile
 * up). Lives in the chat panel header, so "new chat" stays reachable when the
 * sidebar's own new-chat action is tucked away.
 */
export function NewChatCrumb() {
  const t = useT();
  const { threads } = useThreads();
  const { createNewTask } = usePanelActions();

  /**
   * The scope of the page, not of the legacy grammar: on
   * `/$org/agents/{-$project}` the project segment names the agent, so a new chat
   * started there belongs to that project rather than to the Super Agent.
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
