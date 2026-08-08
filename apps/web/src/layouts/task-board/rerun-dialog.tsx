/**
 * Confirm re-running a task with the Super Agent.
 *
 * A confirmation rather than a straight button because a re-run TAKES OVER: it
 * fails whatever run is still holding the task open and starts a fresh one. The
 * check lives here, in front of the human, rather than as a liveness gate on the
 * button — the cards that most need a re-run are the ones whose thread reads
 * `in_progress` forever because its run never started, so a gate would hide the
 * button exactly where it is needed.
 *
 * The warning about superseding is therefore shown whenever a non-terminal
 * thread exists, and phrased as a possibility, not a certainty: from the board
 * we cannot tell a genuinely streaming run from a wedged one.
 */
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Loading01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { TaskBoardItem } from "./config";

/** Thread statuses that mean the run is over. Mirrors the API's
 *  `TERMINAL_THREAD_STATUSES` — inlined rather than imported, since
 *  `apps/web` must not reach into `apps/api/src`. */
const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "expired"]);

export function hasUnfinishedRun(item: TaskBoardItem): boolean {
  return item.threads.some(
    (thread) =>
      thread.status !== null && !TERMINAL_THREAD_STATUSES.has(thread.status),
  );
}

export function RerunDialog({
  items,
  pending,
  onOpenChange,
  onConfirm,
}: {
  /** The tasks to re-run; empty when the dialog is closed. One card or a whole
   *  selection — the only difference is the copy. */
  items: TaskBoardItem[];
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const count = items.length;
  const takeover = items.some(hasUnfinishedRun);

  return (
    <Dialog open={count > 0} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {count > 1
              ? t("taskBoard.rerun.titleMany", { count })
              : t("taskBoard.rerun.title")}
          </DialogTitle>
          <DialogDescription>
            {count > 1
              ? t("taskBoard.rerun.descriptionMany", { count })
              : takeover
                ? t("taskBoard.rerun.descriptionTakeover")
                : t("taskBoard.rerun.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("taskBoard.rerun.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending && <Loading01 className="size-4 animate-spin" />}
            {t("taskBoard.rerun.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
