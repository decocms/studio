/**
 * GitHub install flow.
 *
 * 1. User clicks "Install Decobot". We call `GIT_PROVIDER_INSTALL_URL` and
 *    open the returned URL in a popup window.
 * 2. GitHub takes the user through the App install flow and redirects back to
 *    `/oauth/callback/git-provider?installation_id=...&state=...`.
 * 3. The callback page postMessages back to this opener with the params.
 * 4. We call `GIT_PROVIDER_INSTALL_COMPLETE` to persist the installation row.
 *
 * The popup→postMessage pattern mirrors `connect-provider-dialog.tsx` for
 * AI providers — same shape, different message type.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

interface CallbackMessage {
  type: "GIT_PROVIDER_INSTALL_CALLBACK";
  installationId: string;
  stateToken: string;
}

interface InstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GitProviderInstallDialog({
  open,
  onOpenChange,
}: InstallDialogProps) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  const popupRef = useRef<Window | null>(null);
  const [status, setStatus] = useState<
    "idle" | "opening" | "awaiting-callback" | "completing"
  >("idle");

  const { mutate: complete } = useMutation({
    mutationFn: async (input: {
      installationId: string;
      stateToken: string;
    }) => {
      setStatus("completing");
      await client.callTool({
        name: "GIT_PROVIDER_INSTALL_COMPLETE",
        arguments: {
          providerId: "github",
          installationId: input.installationId,
          stateToken: input.stateToken,
        },
      });
    },
    onSuccess: () => {
      toast.success("Decobot installed successfully");
      queryClient.invalidateQueries({
        queryKey: KEYS.gitProviderInstallations(org.id),
      });
      setStatus("idle");
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast.error(`Install failed: ${error.message}`);
      setStatus("idle");
    },
  });

  // Listen for the popup's postMessage. The dialog mounts when `open` flips
  // true, so the listener attaches before we open the popup.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!open) return;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as CallbackMessage | undefined;
      if (data?.type !== "GIT_PROVIDER_INSTALL_CALLBACK") return;
      complete({
        installationId: data.installationId,
        stateToken: data.stateToken,
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, complete]);

  const startInstall = async () => {
    setStatus("opening");
    try {
      const result = (await client.callTool({
        name: "GIT_PROVIDER_INSTALL_URL",
        arguments: { providerId: "github" },
      })) as { structuredContent?: { url: string; stateToken: string } };
      const url = result.structuredContent?.url;
      if (!url) throw new Error("Server did not return an install URL");

      popupRef.current = window.open(
        url,
        "decobot-install",
        "width=900,height=800",
      );
      if (!popupRef.current) {
        throw new Error(
          "Popup blocked. Allow popups for this site and try again.",
        );
      }
      setStatus("awaiting-callback");
    } catch (err) {
      const error = err as Error;
      toast.error(error.message);
      setStatus("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install Decobot on GitHub</DialogTitle>
          <DialogDescription>
            You'll be sent to GitHub to pick which organization or account
            Decobot can access. Choose the repositories Decobot is allowed to
            read and write — Studio agents will operate within those bounds.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm text-muted-foreground">
          <p>
            Once installed, agents will act on GitHub as <b>you</b> when you
            trigger them (so PRs and issues show your name). Unattended runs
            (event-bus, cron) will act as Decobot.
          </p>
          <p>
            You'll only be asked to install once per GitHub account. Other org
            members will be prompted to link their personal GitHub the first
            time they trigger an agent that touches it.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={startInstall}
            disabled={status !== "idle"}
            className="gap-2"
          >
            {status !== "idle" && <Spinner size="xs" />}
            {status === "idle"
              ? "Continue on GitHub"
              : status === "opening"
                ? "Opening GitHub..."
                : status === "awaiting-callback"
                  ? "Waiting for GitHub..."
                  : "Finalizing..."}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
