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
  return (
    <AlertDialog open={deleteTarget !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {deleteTarget?.kind === "directory" ? "folder" : "file"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete{" "}
            <span className="font-mono">{deleteTarget?.name}</span>
            {deleteTarget?.kind === "directory"
              ? " and everything inside it."
              : "."}
            {deleteDirtyPaths.length > 0 && (
              <>
                {" "}
                {deleteDirtyPaths.length === 1
                  ? "One open file has unsaved changes that will be lost."
                  : `${deleteDirtyPaths.length} open files have unsaved changes that will be lost.`}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={fsActionPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={fsActionPending || !deleteTarget}
            onClick={(e) => {
              e.preventDefault();
              if (deleteTarget) onConfirm(deleteTarget);
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
