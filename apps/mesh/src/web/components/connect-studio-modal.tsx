import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Check, Loading01 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@deco/ui/lib/utils.ts";

interface ConnectionStatus {
  connected: boolean;
  auth: Record<string, string | undefined> | null;
}

interface ConnectStudioStatus {
  claude: ConnectionStatus;
  github: ConnectionStatus;
}

const CONNECT_STUDIO_QK = "connect-studio-status";

function useConnectStudioStatus(org: { slug: string }) {
  return useQuery<ConnectStudioStatus>({
    queryKey: [CONNECT_STUDIO_QK, org.slug],
    queryFn: async () => {
      const res = await fetch(
        `/api/${org.slug}/decopilot/connect-studio/status`,
      );
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
  });
}

function ConnectionCard({
  target,
  logo,
  name,
  status,
  isLoading,
  orgSlug,
}: {
  target: string;
  logo: React.ReactNode;
  name: string;
  status: ConnectionStatus | undefined;
  isLoading: boolean;
  orgSlug: string;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const connected = status?.connected ?? false;
  const auth = status?.auth;

  const handleToggle = async () => {
    setBusy(true);
    const method = connected ? "DELETE" : "POST";
    try {
      const res = await fetch(`/api/${orgSlug}/decopilot/connect-studio`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error ?? "Failed");
      }
      toast.success(connected ? `Disconnected ${name}` : `Connected ${name}!`);
      queryClient.invalidateQueries({ queryKey: [CONNECT_STUDIO_QK] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const authLine = auth
    ? Object.values(auth).filter(Boolean).join(" — ")
    : null;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5",
        connected ? "border-green-200 bg-green-50" : "border-border",
      )}
    >
      <div className="h-5 w-5 shrink-0 flex items-center justify-center">
        {logo}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{name}</span>
          {connected && <Check size={14} className="text-green-600 shrink-0" />}
        </div>
        {authLine && (
          <p className="text-xs text-muted-foreground truncate">{authLine}</p>
        )}
      </div>
      {isLoading ? (
        <Loading01
          size={14}
          className="animate-spin text-muted-foreground shrink-0"
        />
      ) : (
        <Button
          variant={connected ? "ghost" : "outline"}
          size="sm"
          className={cn(
            "shrink-0 h-7 text-xs",
            connected && "text-muted-foreground hover:text-destructive",
          )}
          onClick={handleToggle}
          disabled={busy}
        >
          {busy ? (
            <Loading01 size={12} className="animate-spin" />
          ) : connected ? (
            "Disconnect"
          ) : (
            "Connect"
          )}
        </Button>
      )}
    </div>
  );
}

const GITHUB_SVG = (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

export function ConnectStudioModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { org } = useProjectContext();
  const { data: status, isLoading } = useConnectStudioStatus(org);
  const queryClient = useQueryClient();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          queryClient.invalidateQueries({
            queryKey: [CONNECT_STUDIO_QK, org.slug],
          });
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect Studio</DialogTitle>
          <DialogDescription>
            Install studio tools into your local dev environment.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 pt-1">
          <ConnectionCard
            target="claude-code"
            name="Claude Code"
            logo={
              <img
                src="/logos/Claude Code.svg"
                alt="Claude Code"
                className="h-5 w-5"
                style={{
                  filter:
                    "brightness(0) saturate(100%) invert(55%) sepia(31%) saturate(1264%) hue-rotate(331deg) brightness(92%) contrast(86%)",
                }}
              />
            }
            status={status?.claude}
            isLoading={isLoading}
            orgSlug={org.slug}
          />
          <ConnectionCard
            target="github"
            name="GitHub"
            logo={GITHUB_SVG}
            status={status?.github}
            isLoading={isLoading}
            orgSlug={org.slug}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
