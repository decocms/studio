/**
 * Shared dialog shell for install + OAuth flows. Owns the status copy and
 * footer button states; install/OAuth logic lives in the hook passed in
 * via `flow`. Used by both the GitHub and System Health install paths.
 */

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";

interface InstallFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  errorPrefix: string;
  /** Map of non-error/non-ready status → user-visible label. */
  statusLabel: Record<string, string>;
  flow: {
    status: string;
    error: string | null;
    retry: () => void;
  };
}

export function InstallFlowDialog({
  open,
  onOpenChange,
  title,
  errorPrefix,
  statusLabel,
  flow,
}: InstallFlowDialogProps) {
  const { status, error, retry } = flow;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">
          {status === "error"
            ? `${errorPrefix}: ${error ?? "unknown error"}.`
            : (statusLabel[status] ??
              "An authorization window should open shortly.")}
        </div>
        <DialogFooter>
          {status === "error" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={retry}>Retry</Button>
            </>
          ) : status === "ready" ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
