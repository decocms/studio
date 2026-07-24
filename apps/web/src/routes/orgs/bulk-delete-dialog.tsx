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
            {t("orgs.bulkDeleteDialog.deleteTitle", {
              count,
              plural: count !== 1 ? "s" : "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("orgs.bulkDeleteDialog.deleteDescription", {
              plural: count !== 1 ? "s" : "",
            })}
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
            {t("orgs.bulkDeleteDialog.deleteButton", {
              count,
              plural: count !== 1 ? "s" : "",
            })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
