/**
 * Modal that runs the system-health install + OAuth flow when the
 * error-monitoring preset card resolves to "install-system-health".
 * Mirrors `InstallGithubDialog`: install + OAuth happen inside the hook;
 * this component just owns dialog state, surfaces progress, and fires
 * `onReady` once the connection is created and authenticated so the
 * parent can navigate straight into the chat thread.
 */

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useAutoInstallSystemHealth } from "@/web/hooks/use-auto-install-system-health";

interface InstallSystemHealthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReady?: (connectionId: string, virtualMcpId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  installing: "Installing system health…",
  authenticating: "Authorizing system health…",
  ready: "System health connected.",
};

export function InstallSystemHealthDialog({
  open,
  onOpenChange,
  onReady,
}: InstallSystemHealthDialogProps) {
  const { status, error, retry } = useAutoInstallSystemHealth({
    enabled: open,
    onReady,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up system health</DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">
          {status === "error"
            ? `Couldn't set up system health: ${error ?? "unknown error"}.`
            : (STATUS_LABEL[status] ??
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
