import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { X } from "@untitledui/icons";
import { useCancelQueuedMessage, useThreadQueue } from "./use-thread-queue";

/**
 * Pending-message queue above the composer. Lists the thread's running head +
 * queued messages; each row cancels its own gate workflow. Hidden when empty.
 */
export function ThreadQueuePanel({
  taskId,
  active,
}: {
  taskId: string;
  active: boolean;
}) {
  const { items } = useThreadQueue(taskId, { active });
  const cancel = useCancelQueuedMessage(taskId);
  if (items.length === 0) return null;

  const queuedCount = items.filter((i) => i.status === "queued").length;

  return (
    <div className="mb-1.5 rounded-xl border border-border bg-muted/50 p-2 text-sm">
      <div className="px-1 pb-1 text-xs text-muted-foreground">
        {queuedCount > 0
          ? `${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`
          : "Running"}
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.workflowId}
            className="flex items-center gap-2 rounded-lg bg-background px-2 py-1.5"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                item.status === "running"
                  ? "bg-primary animate-pulse"
                  : "bg-muted-foreground/40",
              )}
            />
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
              title={
                item.status === "running" ? "Cancel run" : "Remove from queue"
              }
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
