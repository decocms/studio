/**
 * QueueTray — the composer-adjacent list of messages waiting behind the
 * active run (tray-only: queued turns never render in the message body,
 * see `selectHiddenFromBody` in `index.tsx`). Mounted above the composer
 * in `input.tsx` whenever the active thread has queued items; renders
 * nothing otherwise.
 *
 * Per-row actions:
 *   - Remove: cancels the queued gate workflow, then drops the stashed
 *     pending body so it can't leak (the workflow id is gone for good) and
 *     the local body row a reload/refetch may have preloaded (otherwise the
 *     cancel would unhide it as a stale, forever-unanswered bubble).
 *   - Send now (head of queue only): cancels the current turn so the gate
 *     FIFO promotes this message next.
 *
 * No edit action, by product decision: DBOS workflow ids are once-ever, so
 * an "edit" can only be cancel + re-POST — which re-enqueues at the TAIL,
 * not in place. That surprises users who expect the message to keep its
 * position, so the affordance was removed until an in-place design exists
 * (`editQueuedMessage` in chat-context still implements the composition).
 */
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowUp, XClose } from "@untitledui/icons";
import { useChatStream } from "./context";
import { dropPendingBody } from "./message-queue-store";
import { selectQueuedItems } from "./queue-items";
import { useMessageQueue, useMessageQueueActions } from "./use-message-queue";

export function QueueTray({ taskId }: { taskId: string }) {
  const items = useMessageQueue(taskId);
  const queued = selectQueuedItems(items);
  const actions = useMessageQueueActions();
  const { stop, removeLocalMessage } = useChatStream();

  if (queued.length === 0) return null;

  return (
    <div className="mb-1 overflow-hidden rounded-2xl border border-border bg-card dark:bg-muted">
      <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {queued.length} queued message{queued.length > 1 ? "s" : ""}
      </div>
      {queued.map((item, index) => (
        <div
          key={item.messageId}
          className="group/queuerow flex items-center gap-2 px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {item.text}
          </span>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/queuerow:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Remove from queue"
              onClick={() =>
                void actions.cancel(taskId, item.messageId).then((ok) => {
                  if (ok) {
                    dropPendingBody(taskId, item.messageId);
                    // A reload/refetch may have preloaded this queued
                    // message's persisted row into the local body store
                    // (render-hidden only while queued) — drop it too or
                    // the cancel unhides it as a stale, forever-unanswered
                    // bubble. No-op when the row was never loaded.
                    removeLocalMessage(item.messageId);
                  }
                })
              }
            >
              <XClose className="size-3.5" />
            </Button>
            {index === 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Send now (cancels the current turn)"
                onClick={() => void stop()}
              >
                <ArrowUp size={14} />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
