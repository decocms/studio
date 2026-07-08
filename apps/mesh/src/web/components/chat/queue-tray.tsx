/**
 * QueueTray — the composer-adjacent list of messages waiting behind the
 * active run (tray-only: queued turns never render in the message body,
 * see `selectHiddenFromBody` in `index.tsx`). Mounted above the composer
 * in `input.tsx` whenever the active thread has queued items; renders
 * nothing otherwise.
 *
 * Per-row actions:
 *   - Edit (hidden for attachment turns — text-only by design): swaps the
 *     row into an inline input; Enter re-POSTs the edited text via
 *     `editQueuedMessage` (cancels the original, re-enqueues at the tail),
 *     Escape cancels. The confirm handler probes the per-thread send latch
 *     FIRST (same probe input.tsx runs before sendMessage) so a racing
 *     send/edit is surfaced with a toast instead of silently dropped, and
 *     the row STAYS in edit mode — draft intact, input disabled — until
 *     `editQueuedMessage` resolves. Only a `true` result leaves edit mode;
 *     on failure the draft is kept so nothing is lost. Because the cancel
 *     step optimistically drops the row from the queue store before the
 *     re-POST lands, a synthetic trailing edit row is rendered whenever the
 *     edited row has left `queued` — it carries the draft through the
 *     in-flight window and doubles as the retry surface if the re-POST
 *     fails (re-confirming is safe: the cancel endpoint treats an
 *     already-gone workflow as success).
 *   - Remove: cancels the queued gate workflow, then drops the stashed
 *     pending body so it can't leak (the workflow id is gone for good).
 *   - Send now (head of queue only): cancels the current turn so the gate
 *     FIFO promotes this message next.
 *
 * While an edit is in flight (`isEditBusy`), every row's Edit/Remove buttons
 * are disabled — not just the row being edited. Without this, clicking Edit
 * on another row reassigns `editingId` away from the in-flight row, which
 * both hides its synthetic retry surface (the `showSyntheticEditRow` check
 * now points at the wrong id) and orphans the pending `editQueuedMessage`
 * promise's `.then` (it would flip `editingId` back to `null` on success,
 * silently "confirming" a row the user never touched).
 */
import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowUp, Edit01, XClose } from "@untitledui/icons";
import { toast } from "sonner";
import { useChatStream } from "./context";
import { dropPendingBody } from "./message-queue-store";
import { selectQueuedItems } from "./queue-items";
import { useMessageQueue, useMessageQueueActions } from "./use-message-queue";

export function QueueTray({ taskId }: { taskId: string }) {
  const items = useMessageQueue(taskId);
  const queued = selectQueuedItems(items);
  const actions = useMessageQueueActions();
  const { stop, editQueuedMessage, isSendInFlight } = useChatStream();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isEditBusy, setIsEditBusy] = useState(false);

  // The row being edited can leave `queued` while the edit is in flight —
  // `queueActions.cancel` drops it optimistically before the re-POST lands
  // (and permanently if the re-POST then fails). Render a synthetic trailing
  // edit row for that window so the user's draft stays visible until the
  // flow resolves, and remains available for retry on failure.
  const showSyntheticEditRow =
    editingId !== null && !queued.some((i) => i.messageId === editingId);
  const rowCount = queued.length + (showSyntheticEditRow ? 1 : 0);

  if (rowCount === 0) return null;

  const confirmEdit = (messageId: string) => {
    const text = draft.trim();
    if (!text || isEditBusy) return;
    // Same probe input.tsx runs before firing sendMessage: if the per-thread
    // send latch is held, editQueuedMessage would reject this edit — tell
    // the user and keep the row in edit mode with the draft intact.
    if (isSendInFlight()) {
      toast.info("Still sending your previous message — try again in a moment");
      return;
    }
    setIsEditBusy(true);
    void editQueuedMessage(messageId, text).then((ok) => {
      setIsEditBusy(false);
      // Leave edit mode only on success. On failure the inner flow has
      // already toasted why; the draft stays put so nothing is lost.
      if (ok) setEditingId(null);
    });
  };

  const editInput = (messageId: string) => (
    <input
      className="min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-50"
      value={draft}
      disabled={isEditBusy}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          confirmEdit(messageId);
        } else if (e.key === "Escape" && !isEditBusy) {
          setEditingId(null);
        }
      }}
      autoFocus
    />
  );

  return (
    <div className="mb-1 rounded-lg border border-border bg-background">
      <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {rowCount} queued message{rowCount > 1 ? "s" : ""}
      </div>
      {queued.map((item, index) => {
        const isEditing = editingId === item.messageId;
        return (
          <div
            key={item.messageId}
            className="group/queuerow flex items-center gap-2 px-3 py-1.5"
          >
            {isEditing ? (
              editInput(item.messageId)
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {item.text}
              </span>
            )}
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/queuerow:opacity-100">
              {!item.hasAttachments && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Edit (re-queues at the end)"
                  disabled={isEditBusy}
                  onClick={() => {
                    setEditingId(item.messageId);
                    setDraft(item.text);
                  }}
                >
                  <Edit01 size={14} />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Remove from queue"
                disabled={isEditBusy}
                onClick={() =>
                  void actions.cancel(taskId, item.messageId).then((ok) => {
                    if (ok) dropPendingBody(taskId, item.messageId);
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
        );
      })}
      {editingId !== null && showSyntheticEditRow && (
        <div className="flex items-center gap-2 px-3 py-1.5">
          {editInput(editingId)}
        </div>
      )}
    </div>
  );
}
