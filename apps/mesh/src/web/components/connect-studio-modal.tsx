import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Check, LinkBroken02, Loading01, RefreshCw01 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@deco/ui/lib/utils.ts";

interface ConnectStatus {
  connected: boolean;
  auth: {
    email?: string;
    orgName?: string;
    subscriptionType?: string;
  } | null;
}

function useConnectStatus(org: { slug: string }) {
  return useQuery<ConnectStatus>({
    queryKey: ["connect-studio-status", org.slug],
    queryFn: async () => {
      const res = await fetch(
        `/api/${org.slug}/decopilot/connect-studio/status`,
      );
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
  });
}

export function ConnectStudioModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { org } = useProjectContext();
  const {
    data: status,
    isLoading,
    refetch,
    isRefetching,
  } = useConnectStatus(org);
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "claude-code" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error ?? "Failed to connect");
      }
      toast.success("Connected to Claude Code!");
      queryClient.invalidateQueries({
        queryKey: ["connect-studio-status", org.slug],
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error ?? "Failed to disconnect");
      }
      toast.success("Disconnected from Claude Code");
      queryClient.invalidateQueries({
        queryKey: ["connect-studio-status", org.slug],
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const connected = status?.connected ?? false;
  const auth = status?.auth;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          queryClient.invalidateQueries({
            queryKey: ["connect-studio-status", org.slug],
          });
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect Studio</DialogTitle>
          <DialogDescription>
            Install all your studio tools into Claude Code.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-1">
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg border px-4 py-3",
              connected ? "border-green-200 bg-green-50" : "border-border",
            )}
          >
            <img
              src="/logos/Claude Code.svg"
              alt="Claude Code"
              className="h-5 w-5 shrink-0"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(55%) sepia(31%) saturate(1264%) hue-rotate(331deg) brightness(92%) contrast(86%)",
              }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Claude Code</span>
                {connected && (
                  <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                    <Check size={12} />
                    Connected
                  </span>
                )}
              </div>
              {auth && (
                <p className="text-xs text-muted-foreground truncate">
                  {auth.email}
                  {auth.orgName ? ` — ${auth.orgName}` : ""}
                  {auth.subscriptionType ? ` (${auth.subscriptionType})` : ""}
                </p>
              )}
            </div>
            {isLoading && (
              <Loading01
                size={16}
                className="animate-spin text-muted-foreground shrink-0"
              />
            )}
          </div>

          <div className="flex gap-2">
            {!connected ? (
              <Button
                className="flex-1"
                onClick={handleConnect}
                disabled={connecting || isLoading}
              >
                {connecting ? (
                  <Loading01 size={14} className="animate-spin mr-1.5" />
                ) : null}
                Connect
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => refetch()}
                  disabled={isRefetching}
                >
                  <RefreshCw01
                    size={14}
                    className={cn(isRefetching && "animate-spin")}
                  />
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 text-destructive hover:text-destructive"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                >
                  {disconnecting ? (
                    <Loading01 size={14} className="animate-spin mr-1.5" />
                  ) : (
                    <LinkBroken02 size={14} className="mr-1.5" />
                  )}
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
