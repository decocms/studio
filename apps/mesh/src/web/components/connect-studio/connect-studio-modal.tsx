import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy01, Key01, RefreshCw05, Zap } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

type Target = "claude-code" | "cursor" | "codex";

interface ConnectStudioStatus {
  claude: {
    connected: boolean;
    auth?: Record<string, string | undefined> | null;
  };
  cursor: { connected: boolean };
  codex: { connected: boolean };
}

interface ConnectResponse {
  success: boolean;
  config?: unknown;
  configRaw?: string;
}

function isLocalhost() {
  return (
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "::1")
  );
}

function getOrigin(): string {
  if (typeof window === "undefined") return "http://localhost:3000";
  return window.location.origin;
}

function buildConfigSnippet(
  target: Target,
  origin: string,
  orgId: string,
  token?: string,
): { code: string; language: string } {
  const tokenValue = token ?? "<generate-token>";

  if (target === "claude-code") {
    return {
      language: "JSON",
      code: JSON.stringify(
        {
          type: "http",
          url: `${origin}/mcp/self`,
          headers: {
            Authorization: `Bearer ${tokenValue}`,
            "x-org-id": orgId,
            "x-mesh-client": "Claude Code",
          },
        },
        null,
        2,
      ),
    };
  }

  if (target === "cursor") {
    return {
      language: "JSON",
      code: JSON.stringify(
        {
          mcpServers: {
            "deco-studio": {
              url: `${origin}/mcp/self`,
              headers: {
                Authorization: `Bearer ${tokenValue}`,
                "x-org-id": orgId,
              },
            },
          },
        },
        null,
        2,
      ),
    };
  }

  return {
    language: "TOML",
    code: [
      "[mcp_servers.deco-studio]",
      `url = "${origin}/mcp/self"`,
      `http_headers = { "Authorization" = "Bearer ${tokenValue}", "x-org-id" = "${orgId}" }`,
    ].join("\n"),
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      onClick={handleCopy}
    >
      {copied ? <Check size={14} /> : <Copy01 size={14} />}
    </Button>
  );
}

function ConfigSnippet({ code, language }: { code: string; language: string }) {
  return (
    <div className="relative rounded-md border border-border bg-muted/50">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="p-3 text-xs overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const CONFIG_PATHS: Record<Target, string> = {
  "claude-code": "claude mcp add-json deco-studio --scope user",
  cursor: "~/.cursor/mcp.json",
  codex: "~/.codex/config.toml",
};

function ConnectTab({
  target,
  label,
  connected,
  generatedToken,
  orgId,
  configPath,
  onGenerateToken,
  onAutoConnect,
  onDisconnect,
  isGenerating,
  isAutoConnecting,
  isDisconnecting,
  authInfo,
}: {
  target: Target;
  label: string;
  connected: boolean;
  generatedToken: string | null;
  orgId: string;
  configPath: string;
  onGenerateToken: (target: Target) => void;
  onAutoConnect: (target: Target) => void;
  onDisconnect: (target: Target) => void;
  isGenerating: boolean;
  isAutoConnecting: boolean;
  isDisconnecting: boolean;
  authInfo?: Record<string, string | undefined> | null;
}) {
  const local = isLocalhost();
  const origin = getOrigin();
  const snippet = buildConfigSnippet(
    target,
    origin,
    orgId,
    generatedToken ?? undefined,
  );

  return (
    <div className="min-h-[220px] space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Badge
            variant={connected ? "default" : "secondary"}
            className="text-[10px]"
          >
            {connected ? "Connected" : "Not connected"}
          </Badge>
        </div>
        {connected && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onDisconnect(target)}
            disabled={isDisconnecting}
          >
            {isDisconnecting ? "Disconnecting..." : "Disconnect"}
          </Button>
        )}
      </div>

      {connected && authInfo && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {Object.entries(authInfo)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <span className="capitalize">{k}</span>: {v}
              </div>
            ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Add to{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
            {configPath}
          </code>
          :
        </p>
        <ConfigSnippet code={snippet.code} language={snippet.language} />
      </div>

      {!connected && (
        <div className="flex items-center gap-2">
          {!generatedToken && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onGenerateToken(target)}
              disabled={isGenerating}
            >
              <Key01 size={14} className="mr-1.5" />
              {isGenerating ? "Generating..." : "Generate Token"}
            </Button>
          )}
          {local && (
            <Button
              size="sm"
              onClick={() => onAutoConnect(target)}
              disabled={isAutoConnecting}
            >
              <Zap size={14} className="mr-1.5" />
              {isAutoConnecting ? "Connecting..." : "Auto-configure"}
            </Button>
          )}
        </div>
      )}
    </div>
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
  const queryClient = useQueryClient();
  const [generatedTokens, setGeneratedTokens] = useState<
    Partial<Record<Target, string>>
  >({});

  const statusQuery = useQuery<ConnectStudioStatus>({
    queryKey: KEYS.connectStudioStatus(org.slug),
    queryFn: async () => {
      const res = await fetch(
        `/api/${org.slug}/decopilot/connect-studio/status`,
      );
      if (!res.ok) throw new Error("Failed to check status");
      return res.json();
    },
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });

  const status = statusQuery.data;

  // Generate token only (no auto-configure)
  const generateTokenMutation = useMutation({
    mutationFn: async (target: Target) => {
      const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, tokenOnly: true }),
      });
      if (!res.ok) throw new Error("Failed to generate token");
      return (await res.json()) as ConnectResponse & { token?: string };
    },
    onSuccess: (data, target) => {
      if (data.token) {
        setGeneratedTokens((prev) => ({ ...prev, [target]: data.token }));
        toast.success("Token generated. Copy the config snippet above.");
      }
    },
    onError: (err) => {
      toast.error(`Token generation failed: ${err.message}`);
    },
  });

  // Auto-configure (token + CLI/file write)
  const connectMutation = useMutation({
    mutationFn: async (target: Target) => {
      const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) throw new Error("Failed to connect");
      return (await res.json()) as ConnectResponse & { token?: string };
    },
    onSuccess: (data, target) => {
      if (data.token) {
        setGeneratedTokens((prev) => ({ ...prev, [target]: data.token }));
      }
      if (data.success) {
        toast.success(`Connected to ${targetLabel(target)}`);
      } else {
        toast.info("Token created. Copy the config to finish setup.");
      }
      queryClient.invalidateQueries({
        queryKey: KEYS.connectStudioStatus(org.slug),
      });
    },
    onError: (err) => {
      toast.error(`Connection failed: ${err.message}`);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (target: Target) => {
      const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      return res.json();
    },
    onSuccess: (_, target) => {
      setGeneratedTokens((prev) => {
        const next = { ...prev };
        delete next[target];
        return next;
      });
      toast.success(`Disconnected from ${targetLabel(target)}`);
      queryClient.invalidateQueries({
        queryKey: KEYS.connectStudioStatus(org.slug),
      });
    },
    onError: (err) => {
      toast.error(`Disconnect failed: ${err.message}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <div className="flex items-center justify-between">
          <DialogTitle className="text-base font-semibold">
            Connect Studio
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: KEYS.connectStudioStatus(org.slug),
              })
            }
          >
            <RefreshCw05
              size={14}
              className={cn(statusQuery.isFetching && "animate-spin")}
            />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Connect your IDE to this studio so every session has access to all
          your agents and tools.
        </p>

        <Tabs defaultValue="claude-code" className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="claude-code" className="flex-1 text-xs">
              Claude Code
            </TabsTrigger>
            <TabsTrigger value="cursor" className="flex-1 text-xs">
              Cursor
            </TabsTrigger>
            <TabsTrigger value="codex" className="flex-1 text-xs">
              Codex
            </TabsTrigger>
          </TabsList>

          {(["claude-code", "cursor", "codex"] as const).map((target) => (
            <TabsContent key={target} value={target} className="mt-4">
              <ConnectTab
                target={target}
                label={targetLabel(target)}
                connected={
                  target === "claude-code"
                    ? (status?.claude?.connected ?? false)
                    : target === "cursor"
                      ? (status?.cursor?.connected ?? false)
                      : (status?.codex?.connected ?? false)
                }
                generatedToken={generatedTokens[target] ?? null}
                orgId={org.id}
                configPath={CONFIG_PATHS[target]}
                onGenerateToken={(t) => generateTokenMutation.mutate(t)}
                onAutoConnect={(t) => connectMutation.mutate(t)}
                onDisconnect={(t) => disconnectMutation.mutate(t)}
                isGenerating={
                  generateTokenMutation.isPending &&
                  generateTokenMutation.variables === target
                }
                isAutoConnecting={
                  connectMutation.isPending &&
                  connectMutation.variables === target
                }
                isDisconnecting={
                  disconnectMutation.isPending &&
                  disconnectMutation.variables === target
                }
                authInfo={
                  target === "claude-code" ? status?.claude?.auth : undefined
                }
              />
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function targetLabel(target: Target): string {
  switch (target) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
  }
}
