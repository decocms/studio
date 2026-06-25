import { Button } from "@deco/ui/components/button.tsx";
import { X } from "@untitledui/icons";
import { useCancelQueuedMessage, useThreadQueue } from "./use-thread-queue";

/**
 * Pending-message queue above the composer. Lists only the messages *waiting*
 * behind the active run — the running head is excluded here because it's
 * already rendered in the chat body. Each row cancels its own gate workflow.
 * Hidden when nothing is queued.
 */
export function ThreadQueuePanel({ taskId }: { taskId: string }) {
  const { items } = useThreadQueue(taskId);
  const cancel = useCancelQueuedMessage(taskId);
  const queued = items.filter((i) => i.status === "queued");
  if (queued.length === 0) return null;

  return (
    <div className="mb-1.5 rounded-xl border border-border bg-muted/50 p-2 text-sm">
      <div className="px-1 pb-1 text-xs text-muted-foreground">
        {`${queued.length} queued message${queued.length === 1 ? "" : "s"}`}
      </div>
      <ul className="flex flex-col gap-1">
        {queued.map((item) => (
          <li
            key={item.workflowId}
            className="flex items-center gap-2 rounded-lg bg-background px-2 py-1.5"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {item.text || (
                <span className="text-muted-foreground">(no text)</span>
              )}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
              title="Remove from queue"
              onClick={() => cancel(item.workflowId)}
            >
              <X size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
