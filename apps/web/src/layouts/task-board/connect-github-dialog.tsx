import { Loading01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { useT } from "@/i18n/use-t.ts";
import { GitHubIcon } from "@/components/icons/github-icon";
import { useConnectApp } from "@/hooks/use-connect-app";

export function ConnectGitHubDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the connect attempt settles, success or failure — the
   *  caller (the repo picker) has its own auto-install fallback either way. */
  onConnected: () => void;
}) {
  const t = useT();
  const { connect, isConnecting } = useConnectApp("deco/mcp-github");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="flex h-28 items-center justify-center bg-gradient-to-br from-muted via-muted to-accent">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-sm">
            <GitHubIcon className="size-7" />
          </div>
        </div>
        <div className="flex flex-col gap-4 p-6">
          <DialogHeader>
            <DialogTitle>
              {t("taskBoard.taskBoard.connectGithubTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("taskBoard.taskBoard.connectGithubDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={async () => {
                await connect();
                onOpenChange(false);
                onConnected();
              }}
              disabled={isConnecting}
              className="gap-2"
            >
              {isConnecting ? (
                <Loading01 size={16} className="animate-spin" />
              ) : (
                <GitHubIcon className="size-4" />
              )}
              {t("taskBoard.taskBoard.connectGithubButton")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
