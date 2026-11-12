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
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { usePanelActions } from "@/layouts/shell-layout";
import { useT } from "@/i18n/use-t.ts";

/** A fresh chat with the org's assistant; the page you're on is only context. */
export function NewChatCrumb() {
  const t = useT();
  const { org } = useProjectContext();
  const { createNewTask } = usePanelActions();

  // ALWAYS create a fresh chat — never reuse/refocus an existing empty one.
  const handleNewChat = () => {
    void createNewTask(getWellKnownDecopilotVirtualMCP(org.id).id, null);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleNewChat}
          aria-label={t("sidebar.taskGroupsList.newChat")}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
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
