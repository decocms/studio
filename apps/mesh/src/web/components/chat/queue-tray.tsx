/**
 * QueueTray — the composer-adjacent list of messages waiting behind the
 * active run (tray-only: queued turns never render in the message body,
 * see `selectHiddenFromBody` in `index.tsx`). Mounted above the composer
 * in `input.tsx` whenever the active thread has queued items; renders
 * nothing otherwise.
 *
 * Layout (V1, settled via visual companion 2026-07-08): quiet header —
 * "N queued" left, an outlined "Send next" button right — above a flat
 * numbered list. Rows are uniform (`number chip · text · ✕ on hover`);
 * numbers make the FIFO order legible, and the single header button makes
 * it honest that only the HEAD can be promoted.
 *
 * Actions:
 *   - Send next (header): cancels the current turn so the gate FIFO
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
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { ArrowUp, XClose } from "@untitledui/icons";
import { useT } from "@/web/i18n/use-t.ts";
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
    <div className="mb-1 overflow-hidden rounded-2xl border border-border bg-card dark:bg-muted">
      <div className="flex items-center justify-between gap-2 border-b border-border py-1.5 pr-2 pl-3 text-xs text-muted-foreground">
        <span>
          {t(
            queued.length === 1
              ? "chat.queueTray.queuedMessage"
              : "chat.queueTray.queuedMessages",
            { count: queued.length },
          )}
        </span>
        <Tooltip delayDuration={400}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void stop()}
            >
              <ArrowUp size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">{t("chat.queueTray.sendNow")}</p>
          </TooltipContent>
        </Tooltip>
      </div>
      {queued.map((item, index) => (
        <div
          key={item.messageId}
          className="group/queuerow flex items-center gap-2 px-3 py-1.5"
        >
          {/* Chip surface must differ from the tray surface in BOTH modes —
              the tray is bg-card light / bg-muted dark, so bg-muted would
              vanish in dark mode. */}
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground dark:bg-background">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {item.text}
          </span>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/queuerow:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={t("chat.queueTray.removeFromQueue")}
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
