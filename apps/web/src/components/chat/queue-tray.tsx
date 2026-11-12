/**
 * QueueTray — the composer-adjacent list of messages waiting behind the
 * active run (tray-only: queued turns never render in the message body,
 * see `selectHiddenFromBody` in `index.tsx`). Mounted above the composer
 * in `input.tsx` whenever the active thread has queued items; renders
 * nothing otherwise.
 *
 * Layout: each queued message is a dashed bubble on the right, where it
 * will land once sent, with its time and actions under it. Only the HEAD
 * offers "Send now", since only it can be promoted.
 *
 * Actions:
 *   - Send now (head only): cancels the current turn so the gate FIFO
 *     promotes the first queued message — same stop() as the composer's
 *     stop button.
 *   - Remove (per row): cancels the queued gate workflow, then drops the
 *     stashed pending body so it can't leak (the workflow id is gone for
 *     good) and the local body row a reload/refetch may have preloaded
 *     (otherwise the cancel would unhide it as a stale, forever-unanswered
 *     bubble).
 *
 * No edit action, by product decision: DBOS workflow ids are once-ever, so
 * an "edit" can only be cancel + re-POST — which re-enqueues at the TAIL,
 * not in place. That surprises users who expect the message to keep its
 * position, so the affordance was removed until an in-place design exists
 * (`editQueuedMessage` in chat-context still implements the composition).
 */
import { Button } from "@decocms/ui/components/button.tsx";
import { ArrowUp, XClose } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useChatStream } from "./context";
import { dropPendingBody } from "./message-queue-store";
import { selectQueuedItems } from "./queue-items";
import { useMessageQueue, useMessageQueueActions } from "./use-message-queue";

export function QueueTray({ taskId }: { taskId: string }) {
  const t = useT();
  const items = useMessageQueue(taskId);
  const queued = selectQueuedItems(items);
  const actions = useMessageQueueActions();
  const { stop, removeLocalMessage } = useChatStream();

  if (queued.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col items-end gap-3 px-2.5">
      {queued.map((item, index) => (
        <div
          key={item.messageId}
          className="flex max-w-[85%] flex-col items-end"
        >
          <div className="min-w-0 rounded-2xl border border-dashed border-border px-4 py-2.5 text-sm wrap-break-word text-muted-foreground">
            {item.text}
          </div>
          <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            <span className="mr-1 select-none">
              {new Date(item.enqueuedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            {index === 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                onClick={() => void stop()}
              >
                <ArrowUp size={12} />
                {t("chat.queueTray.sendNow")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 text-muted-foreground"
              title={t("chat.queueTray.removeFromQueue")}
              aria-label={t("chat.queueTray.removeFromQueue")}
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
          </div>
        </div>
      ))}
    </div>
  );
}
