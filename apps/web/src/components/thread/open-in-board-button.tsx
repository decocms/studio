import { useNavigate } from "@tanstack/react-router";
import { LayoutAlt01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useChatTask } from "@/components/chat/chat-context";
import { useTaskForThread } from "@/hooks/use-task-for-thread";
import { useT } from "@/i18n/use-t.ts";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";

/**
 * Header action: when the current thread is linked to a task board item, open
 * the Tasks overlay in the main panel with that task's modal open (same
 * `?main=board` surface as the Tasks toggle). Renders nothing when the thread
 * has no linked task (or the board is disabled — the lookup returns null then).
 */
export function OpenInBoardButton() {
  const t = useT();
  const { taskId } = useChatTask();
  const navigate = useNavigate();
  const boardTaskId = useTaskForThread(taskId);

  if (!boardTaskId) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            aria-label={t("thread.openInBoardButton.openTaskAriaLabel")}
            onClick={() =>
              navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  main: "board",
                  task: boardTaskId,
                }),
              })
            }
          >
            <LayoutAlt01 size={16} />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent>
          {t("thread.openInBoardButton.openTaskInBoard")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
