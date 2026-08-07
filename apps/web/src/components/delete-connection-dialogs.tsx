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
import type { DeleteConnectionState } from "@/hooks/use-delete-connection";

export function DeleteConnectionDialogs({
  deleteState,
  cancelDelete,
  confirmDelete,
  confirmForceDelete,
}: {
  deleteState: DeleteConnectionState;
  cancelDelete: () => void;
  confirmDelete: () => void;
  confirmForceDelete: () => void;
}) {
  const t = useT();
  return (
    <>
      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteState.mode === "deleting"}
        onOpenChange={(open) => {
          if (!open) cancelDelete();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("common.deleteConnectionDialogs.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("common.deleteConnectionDialogs.description")}{" "}
              <span className="font-medium text-foreground">
                {deleteState.mode === "deleting" &&
                  deleteState.connection.title}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("common.deleteConnectionDialogs.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.deleteConnectionDialogs.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteState.mode === "force-deleting"}
        onOpenChange={(open) => {
          if (!open) cancelDelete();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("common.deleteConnectionDialogs.forceDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {t("common.deleteConnectionDialogs.forceDeleteDescription")}{" "}
                  <span className="font-medium text-foreground">
                    {deleteState.mode === "force-deleting" &&
                      deleteState.connection.title}
                  </span>{" "}
                  {t("common.deleteConnectionDialogs.isUsedByAgents")}{" "}
                  <span className="font-medium text-foreground">
                    {deleteState.mode === "force-deleting" &&
                      deleteState.agentNames}
                  </span>
                  .
                </p>
                <p className="mt-2">
                  {t("common.deleteConnectionDialogs.forceDeleteWarning")}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("common.deleteConnectionDialogs.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmForceDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.deleteConnectionDialogs.deleteAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
