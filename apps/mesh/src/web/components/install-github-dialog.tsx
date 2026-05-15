/**
 * Modal that fires the GitHub install + OAuth flow when the "Install
 * GitHub" preset task card is clicked. The actual install/OAuth lives
 * in `useAutoInstallGitHub`; this component just owns the open state,
 * shows progress, and invalidates the preset-tasks query on success so
 * the card flips to "Set up error monitoring" on close.
 */

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useAutoInstallGitHub } from "@/web/hooks/use-auto-install-github";

interface InstallGithubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_LABEL: Record<string, string> = {
  installing: "Installing GitHub…",
  authenticating: "Authorizing with GitHub…",
  ready: "GitHub installed.",
};

export function InstallGithubDialog({
  open,
  onOpenChange,
}: InstallGithubDialogProps) {
  // Hook auto-fires when enabled and handles its own query invalidation
  // (incl. preset-tasks), so the card flips automatically when GH is
  // installed — here we just own dialog state and surface progress.
  const { status, error, retry } = useAutoInstallGitHub({ enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install GitHub</DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">
          {status === "error"
            ? `Couldn't install GitHub: ${error ?? "unknown error"}.`
            : (STATUS_LABEL[status] ??
              "A GitHub authorization window should open shortly.")}
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
