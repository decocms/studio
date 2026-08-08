import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { useT } from "@/i18n/use-t.ts";

export function BulkDeleteDialog({
  open,
  onOpenChange,
  count,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              count === 1
                ? "orgs.bulkDeleteDialog.deleteTitleSingular"
                : "orgs.bulkDeleteDialog.deleteTitlePlural",
              { count },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              count === 1
                ? "orgs.bulkDeleteDialog.deleteDescriptionSingular"
                : "orgs.bulkDeleteDialog.deleteDescriptionPlural",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("orgs.bulkDeleteDialog.cancelButton")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t(
              count === 1
                ? "orgs.bulkDeleteDialog.deleteButtonSingular"
                : "orgs.bulkDeleteDialog.deleteButtonPlural",
              { count },
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
