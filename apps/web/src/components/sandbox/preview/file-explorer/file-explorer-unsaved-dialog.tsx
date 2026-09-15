import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { useT } from "@/i18n/use-t.ts";

export function FileExplorerUnsavedDialog({
  path,
  saving,
  error,
  onOpenChange,
  onDiscard,
  onSave,
}: {
  path: string | null;
  saving: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useT();
  const name = path?.split("/").pop() ?? path ?? "";

  return (
    <AlertDialog open={path !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("sandbox.fileExplorerUnsavedDialog.title", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("sandbox.fileExplorerUnsavedDialog.description")}
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>
            {t("sandbox.fileExplorerUnsavedDialog.cancel")}
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={saving}
            onClick={onDiscard}
          >
            {t("sandbox.fileExplorerUnsavedDialog.discard")}
          </Button>
          <Button type="button" disabled={saving} onClick={onSave}>
            {saving ? (
              <>
                <Spinner className="size-3.5" />
                {t("sandbox.fileExplorerUnsavedDialog.saving")}
              </>
            ) : (
              t("sandbox.fileExplorerUnsavedDialog.save")
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
