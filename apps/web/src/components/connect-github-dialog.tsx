import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Loading01 } from "@untitledui/icons";
import { GitHubIcon } from "@/components/icons/github-icon";
import { useConnectApp } from "@/hooks/use-connect-app";
import { useT } from "@/i18n/use-t.ts";

/**
 * "Connect GitHub" prompt — originally the task board's Auto-fix gate (the
 * Super Agent needs a repo to open a PR), now also opened from the commerce
 * report's autopilot hand-off via `studio://navigate?connectGithub=1` (see
 * project-app-navigate.ts). Same dialog either way, so connecting GitHub
 * always looks and behaves identically regardless of entry point.
 */
export function ConnectGitHubDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { connect, isConnecting } = useConnectApp("deco/mcp-github");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
      </DialogContent>
    </Dialog>
  );
}
