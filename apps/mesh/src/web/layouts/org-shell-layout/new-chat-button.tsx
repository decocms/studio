import { Edit05 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { useSearch, useParams } from "@tanstack/react-router";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";

export function NewChatButton() {
  const { createNewTask, setChatOpen } = usePanelActions();
  const { org } = useProjectContext();
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const params = useParams({ strict: false }) as { taskId?: string };

  const handleClick = () => {
    const agentId =
      search.virtualmcpid ?? getWellKnownDecopilotVirtualMCP(org.id).id;
    setChatOpen(true);
    if (!params.taskId) {
      createNewTask(agentId);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 h-7 text-sm font-medium"
      onClick={handleClick}
    >
      <Edit05 size={14} />
      New chat
    </Button>
  );
}
