import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { Capability } from "@/links/protocol";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { KEYS } from "@/web/lib/query-keys";

const INSTALL_SNIPPET = "bunx decocms link";

const CAPABILITY_LABELS: Partial<Record<Capability, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Format the link's capability list for UI display. Drops
 * `decopilot-sandbox` (always present and not meaningful to the user)
 * and maps the rest to friendly labels. Returns the empty array when
 * nothing user-facing is available.
 */
export function visibleCapabilities(caps: readonly Capability[]): string[] {
  return caps
    .map((c) => CAPABILITY_LABELS[c])
    .filter((label): label is string => Boolean(label));
}

/**
 * CLI agents the linked desktop does NOT advertise, as friendly labels.
 * Drives the remediation copy: the daemon re-probes every minute, so a
 * CLI installed (and signed into) after linking shows up here on its own.
 */
function missingCliLabels(caps: readonly Capability[]): string[] {
  return (Object.keys(CAPABILITY_LABELS) as Capability[])
    .filter((c) => !caps.includes(c))
    .map((c) => CAPABILITY_LABELS[c])
    .filter((label): label is string => Boolean(label));
}

interface ConnectDesktopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectDesktopDialog({
  open,
  onOpenChange,
}: ConnectDesktopDialogProps) {
  const link = useCurrentLink();
  const [copied, setCopied] = useState(false);
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Tells the linked daemon to shut down (a `shutdown` control frame rides
  // its held control long-poll) and removes the presence claim, so the link
  // flips offline immediately. The dialog then shows the reconnect snippet.
  const disconnect = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "LINK_DISCONNECT",
        arguments: {},
      })) as { isError?: boolean; content?: { text?: string }[] };
      if (result?.isError) {
        throw new Error(
          result.content?.[0]?.text ?? "Failed to disconnect desktop",
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: KEYS.currentLink(org.id),
      });
    },
    onError: (err) => {
      toast.error(`Disconnect failed: ${err.message}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {link.online ? "Desktop connected" : "Connect your desktop"}
          </DialogTitle>
          <DialogDescription>
            {link.online
              ? "Your desktop is online. Pick a desktop agent in the chat to use it."
              : "Run this command in your desktop terminal. The dialog will close once your desktop is online."}
          </DialogDescription>
        </DialogHeader>

        {!link.online && (
          <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-sm">
            <span className="flex-1">{INSTALL_SNIPPET}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                navigator.clipboard.writeText(INSTALL_SNIPPET);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={14} /> : <Copy01 size={14} />}
            </Button>
          </div>
        )}

        {!link.online ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            Waiting for desktop…
          </div>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-foreground">
              {link.hostname ?? link.machineId ?? "Your desktop"} is linked.
            </p>
            {visibleCapabilities(link.capabilities).length > 0 && (
              <p className="text-muted-foreground">
                Available: {visibleCapabilities(link.capabilities).join(", ")}
              </p>
            )}
            {missingCliLabels(link.capabilities).length > 0 && (
              <p className="text-muted-foreground">
                {missingCliLabels(link.capabilities).join(" and ")}{" "}
                {missingCliLabels(link.capabilities).length > 1
                  ? "were"
                  : "was"}{" "}
                not detected on this desktop. Install the CLI and sign in there
                — it appears here automatically within a minute.
              </p>
            )}
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
                className="text-destructive hover:text-destructive"
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect desktop"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
