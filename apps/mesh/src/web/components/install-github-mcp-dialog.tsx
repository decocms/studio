/**
 * Install GitHub MCP Dialog
 *
 * Tiny wrapper around `useAutoInstallGitHub` for the Storefront Manager
 * checklist's "Connect GitHub" item. No repo picker, no virtual MCP
 * creation — just installs the GitHub MCP connection and runs OAuth.
 * Shows a success state once connected; user dismisses.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useConnections } from "@decocms/mesh-sdk";
import { Check } from "@untitledui/icons";
import { useAutoInstallGitHub } from "@/web/hooks/use-auto-install-github";
import { AutoInstallGitHubUI } from "@/web/components/github-repo-picker";

export function InstallGitHubMcpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const githubConnections = useConnections({ slug: "mcp-github" });
  const alreadyInstalled = githubConnections.length > 0;

  const autoInstall = useAutoInstallGitHub({
    enabled: open && !alreadyInstalled,
  });

  const isReady = alreadyInstalled || autoInstall.status === "ready";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Connect GitHub</DialogTitle>
        </DialogHeader>
        {isReady ? (
          <div className="flex flex-col items-center gap-4 px-6 py-10">
            <div className="size-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <Check className="size-5 text-emerald-500" />
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="text-sm font-medium">GitHub connected</p>
              <p className="text-xs text-muted-foreground">
                You can now add storefronts from your repositories.
              </p>
            </div>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <AutoInstallGitHubUI
            status={
              autoInstall.status === "idle" ? "installing" : autoInstall.status
            }
            error={autoInstall.error}
            retry={autoInstall.retry}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
