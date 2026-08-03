/**
 * Confirm dialog shown when archiving the LAST open chat on a branch in the
 * desktop app — the archive also stops that branch's running processes and
 * deletes its local files.
 *
 * Deliberately static: it states the two consequences and asks. It does NOT
 * inspect the branch for uncommitted or unpushed work, so it makes no claim
 * either way about what is or isn't saved — the user is trusted to know the
 * state of their own branch.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { buttonVariants } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";

export function ArchiveWorktreeDialog({
  branch,
  onOutcome,
}: {
  branch: string;
  onOutcome: (outcome: "cancel" | "confirm") => void;
}) {
  const t = useT();

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onOutcome("cancel");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("sidebar.archiveWorktreeDialog.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* TODO(i18n): rich text — the branch name is monospaced mid-sentence. */}
            {t("sidebar.archiveWorktreeDialog.stopsAndDeletesBefore")}{" "}
            <span className="font-mono">{branch}</span>{" "}
            {t("sidebar.archiveWorktreeDialog.stopsAndDeletesAfter")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOutcome("cancel")}>
            {t("sidebar.archiveWorktreeDialog.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={() => onOutcome("confirm")}
          >
            {t("sidebar.archiveWorktreeDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
