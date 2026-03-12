import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Check, Loading01, RefreshCw01 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@deco/ui/lib/utils.ts";

type Target = "claude-code" | "cursor";
type Status = Record<Target, boolean>;

function useConnectStatus(org: { slug: string }) {
  return useQuery<Status>({
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

function ConnectButton({
  target,
  label,
  logo,
  logoStyle,
  connected,
  statusLoading,
}: {
  target: Target;
  label: string;
  logo: string;
  logoStyle?: React.CSSProperties;
  connected: boolean;
  statusLoading: boolean;
}) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error ?? "Failed to connect");
      }
      toast.success(`Connected to ${label}!`);
      queryClient.invalidateQueries({
        queryKey: ["connect-studio-status", org.slug],
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to connect studio",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={connected ? undefined : handleConnect}
      disabled={loading || statusLoading}
      className={cn(
        "flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
        connected
          ? "border-green-200 bg-green-50 cursor-default"
          : "border-border hover:border-ring/50 hover:bg-accent/50 cursor-pointer",
        (loading || statusLoading) && "opacity-60",
      )}
    >
      <img
        src={logo}
        alt={label}
        className="h-5 w-5 shrink-0"
        style={logoStyle}
      />
      <span className="flex-1 text-sm font-medium">{label}</span>
      {statusLoading ? (
        <Loading01 size={16} className="animate-spin text-muted-foreground" />
      ) : loading ? (
        <Loading01 size={16} className="animate-spin" />
      ) : connected ? (
        <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
          <Check size={14} />
          Connected
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Connect</span>
      )}
    </button>
  );
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
          <div className="flex items-center justify-between">
            <DialogTitle>Connect Studio</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              onClick={() => refetch()}
              disabled={isRefetching}
            >
              <RefreshCw01
                size={14}
                className={cn(isRefetching && "animate-spin")}
              />
            </Button>
          </div>
          <DialogDescription>
            One-click install all your studio tools into your IDE.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 pt-1">
          <ConnectButton
            target="claude-code"
            label="Claude Code"
            logo="/logos/Claude Code.svg"
            logoStyle={{
              filter:
                "brightness(0) saturate(100%) invert(55%) sepia(31%) saturate(1264%) hue-rotate(331deg) brightness(92%) contrast(86%)",
            }}
            connected={status?.["claude-code"] ?? false}
            statusLoading={isLoading}
          />
          <ConnectButton
            target="cursor"
            label="Cursor"
            logo="/logos/cursor.svg"
            logoStyle={{
              filter:
                "brightness(0) saturate(100%) invert(11%) sepia(8%) saturate(785%) hue-rotate(1deg) brightness(95%) contrast(89%)",
            }}
            connected={status?.cursor ?? false}
            statusLoading={isLoading}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
