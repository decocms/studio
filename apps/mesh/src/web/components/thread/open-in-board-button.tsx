import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { LayoutAlt01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useChatTask } from "@/web/components/chat/chat-context";
import { useTaskForThread } from "@/web/hooks/use-task-for-thread";
import { useT } from "@/web/i18n/use-t.ts";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";

/**
 * Header action: when the current thread is linked to a task board item, jump
 * to the board with that task's modal open. Renders nothing when the thread has
 * no linked task (or the board is disabled — the lookup returns null then).
 */
export function OpenInBoardButton() {
  const t = useT();
  const { org } = useProjectContext();
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
                to: "/$org/board",
                params: { org: org.slug },
                search: { task: boardTaskId },
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
