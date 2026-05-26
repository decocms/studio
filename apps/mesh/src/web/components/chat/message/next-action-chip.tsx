import { ArrowRight, Stars02 } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useChatStream, useOptionalChatTask } from "../context.tsx";
import { useStudioPackChecklists } from "@/web/layouts/tasks-panel/use-studio-pack-checklists";

export function NextActionChip() {
  const task = useOptionalChatTask();
  const { sendMessage, isStreaming, messages } = useChatStream();
  const { org } = useProjectContext();
  const virtualMcpId = task?.virtualMcpId;
  const { checklists } = useStudioPackChecklists(org.slug);

  if (!virtualMcpId || isStreaming) return null;

  // The welcome message already prompts the same first action that brought
  // the user here. Only suggest a "next" once the user has actually done
  // something in this thread.
  const hasUserTurn = messages.some((m) => m.role === "user");
  if (!hasUserTurn) return null;

  const match = checklists.find((c) => c.agent.id === virtualMcpId);
  const nextItem = match?.items.find(
    (i) => !i.completed && i.action.kind === "open-agent-thread",
  );
  if (!nextItem || nextItem.action.kind !== "open-agent-thread") return null;
  const prompt = nextItem.action.prompt;

  return (
    <button
      type="button"
      onClick={() => {
        void sendMessage({
          parts: [{ type: "text", text: prompt }],
        });
      }}
      className="group mt-3 flex items-center gap-2 self-start rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
    >
      <Stars02 size={12} className="shrink-0 text-purple-500" />
      <span className="font-medium text-foreground/80">Next:</span>
      <span className="truncate">{nextItem.label}</span>
      <ArrowRight
        size={12}
        className="shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
      />
    </button>
  );
}
