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
import type { TreeNode } from "./types";

export function FileExplorerDeleteDialog({
  deleteTarget,
  deleteDirtyPaths,
  fsActionPending,
  onOpenChange,
  onConfirm,
}: {
  deleteTarget: TreeNode | null;
  deleteDirtyPaths: string[];
  fsActionPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (node: TreeNode) => void;
}) {
  const t = useT();
  const isFolder = deleteTarget?.kind === "directory";
  return (
    <AlertDialog open={deleteTarget !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              isFolder
                ? "sandbox.fileExplorerDeleteDialog.titleFolder"
                : "sandbox.fileExplorerDeleteDialog.titleFile",
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("sandbox.fileExplorerDeleteDialog.description")}{" "}
            <span className="font-mono">{deleteTarget?.name}</span>
            {isFolder
              ? t("sandbox.fileExplorerDeleteDialog.folderSuffix")
              : "."}
            {deleteDirtyPaths.length > 0 && (
              <>
                {" "}
                {deleteDirtyPaths.length === 1
                  ? t("sandbox.fileExplorerDeleteDialog.unsavedChangesOne")
                  : t("sandbox.fileExplorerDeleteDialog.unsavedChangesMany", {
                      count: deleteDirtyPaths.length,
                    })}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={fsActionPending}>
            {t("sandbox.fileExplorerDeleteDialog.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={fsActionPending || !deleteTarget}
            onClick={(e) => {
              e.preventDefault();
              if (deleteTarget) onConfirm(deleteTarget);
            }}
          >
            {t("sandbox.fileExplorerDeleteDialog.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
