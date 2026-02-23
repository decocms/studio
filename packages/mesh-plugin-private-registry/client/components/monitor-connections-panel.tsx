import { useState } from "react";
import { authenticateMcp, isConnectionAuthenticated } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { toast } from "sonner";
import {
  useSyncMonitorConnections,
  useMonitorConnections,
  useMonitorResults,
  useMonitorRuns,
  useUpdateMonitorConnectionAuth,
} from "../hooks/use-monitor";
import { KEYS } from "../lib/query-keys";
import { cn } from "@deco/ui/lib/utils.ts";
import { useRegistryMutations } from "../hooks/use-registry";
import type {
  MonitorConnectionAuthStatus,
  MonitorConnectionListItem,
} from "../lib/types";
import { DotsVertical } from "@untitledui/icons";

type SourceFilter = "all" | "store" | "request";

function authBadgeStyle(status: MonitorConnectionAuthStatus) {
  switch (status) {
    case "authenticated":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
    case "needs_auth":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20";
    default:
      return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
  }
}

function authBadgeLabel(status: MonitorConnectionAuthStatus) {
  switch (status) {
    case "authenticated":
      return "Authenticated";
    case "needs_auth":
      return "Needs Auth";
    default:
      return "Not checked";
  }
}

function ConnectionRow({
  entry,
  onAuthChanged,
  failedToolsCount,
  failedResultCount,
}: {
  entry: MonitorConnectionListItem;
  onAuthChanged: () => void;
  failedToolsCount: number;
  failedResultCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [tokenValue, setTokenValue] = useState("");
  const [isReplacingToken, setIsReplacingToken] = useState(false);

  const updateAuth = useUpdateMonitorConnectionAuth();
  const { updateMutation } = useRegistryMutations();
  const connectionId = entry.mapping.connection_id;
  const authStatus = entry.mapping.auth_status;
  const title = entry.item?.title ?? entry.mapping.item_id;
  const icon = entry.item?.server?.icons?.[0]?.src ?? null;
  const isPublic = entry.item?.is_public ?? false;
  const isUnlisted = entry.item?.is_unlisted ?? false;
  const isRequestSource = entry.source === "request";
  const probeQuery = useQuery({
    queryKey: KEYS.monitorConnectionAuthProbe(connectionId),
    queryFn: async () =>
      isConnectionAuthenticated({
        url: `/mcp/${connectionId}`,
        token: null,
      }),
    staleTime: 10_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const probeResult = probeQuery.data;
  const isProbeLoading = probeQuery.isLoading;
  const supportsOAuth = probeResult?.supportsOAuth ?? false;
  const hasOAuthToken = probeResult?.hasOAuthToken ?? false;
  const isServerError = probeResult?.isServerError ?? false;
  const probeIsAuthenticated = probeResult?.isAuthenticated ?? false;
  const authFlavor = isProbeLoading
    ? "checking"
    : isServerError
      ? "server_error"
      : supportsOAuth
        ? probeIsAuthenticated
          ? hasOAuthToken
            ? "oauth_connected"
            : "connected"
          : "oauth_available"
        : probeIsAuthenticated
          ? "connected"
          : "token_required";

  const markAuthenticated = () => {
    updateAuth.mutate(
      { connectionId, authStatus: "authenticated" },
      { onSuccess: () => onAuthChanged() },
    );
  };

  const handleAuthenticate = async () => {
    setBusy(true);
    try {
      // Recheck before choosing OAuth vs token guidance
      const probe = await probeQuery.refetch();
      const status = probe.data;
      if (!status) {
        toast.error(`Could not reach "${title}". The remote MCP may be down.`);
        return;
      }

      if (status.isAuthenticated) {
        toast.success(
          `"${title}" is reachable. You can re-authenticate if needed.`,
        );
        return;
      }

      if (status.isServerError) {
        toast.error(`Server error for "${title}". The remote MCP may be down.`);
        return;
      }

      if (!status.supportsOAuth) {
        toast.warning(
          `"${title}" does not support OAuth. Use the Token field to paste an API key.`,
        );
        return;
      }

      // Server supports OAuth — trigger the flow
      toast.info(`Opening authentication window for "${title}"...`);
      const authResult = await authenticateMcp({
        connectionId,
        clientName: `MCP Test - ${title}`,
        timeout: 180000,
      });

      if (authResult.error) {
        toast.error(`OAuth failed for "${title}": ${authResult.error}`);
        return;
      }

      // Save OAuth tokens
      if (authResult.tokenInfo) {
        const res = await fetch(
          `/api/connections/${connectionId}/oauth-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              accessToken: authResult.tokenInfo.accessToken,
              refreshToken: authResult.tokenInfo.refreshToken,
              expiresIn: authResult.tokenInfo.expiresIn,
              scope: authResult.tokenInfo.scope,
              clientId: authResult.tokenInfo.clientId,
              clientSecret: authResult.tokenInfo.clientSecret,
              tokenEndpoint: authResult.tokenInfo.tokenEndpoint,
            }),
          },
        );
        if (!res.ok) {
          // Fallback: save as plain token
          if (authResult.token) {
            await saveTokenInternal(authResult.token);
          }
        }
      } else if (authResult.token) {
        await saveTokenInternal(authResult.token);
      }

      toast.success(`"${title}" authenticated!`);
      markAuthenticated();
      await probeQuery.refetch();
    } catch (err) {
      console.error("[MonitorConnectionsPanel] Auth error:", err);
      toast.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveTokenInternal = async (token: string) => {
    const res = await fetch("/mcp/self", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "COLLECTION_CONNECTIONS_UPDATE",
          arguments: {
            id: connectionId,
            data: { connection_token: token },
          },
        },
      }),
    });
    if (!res.ok) {
      throw new Error("Failed to save token");
    }
  };

  const handleSaveToken = async () => {
    if (!tokenValue.trim()) {
      toast.error("Token cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      await saveTokenInternal(tokenValue);
      toast.success(`Token saved for "${title}"!`);
      setIsReplacingToken(false);
      setTokenValue("");
      markAuthenticated();
      await probeQuery.refetch();
    } catch (err) {
      toast.error(
        `Error saving token: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const showMaskedToken =
    authStatus === "authenticated" &&
    !hasOAuthToken &&
    !isReplacingToken &&
    tokenValue.length === 0;
  const applyVisibility = async (patch: {
    is_public?: boolean;
    is_unlisted?: boolean;
  }) => {
    if (isRequestSource) {
      toast.info("Visibility controls are available only for store items.");
      return;
    }
    if (!entry.item) {
      toast.error("Registry item not found for this connection.");
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: entry.item.id,
        data: patch,
      });
      toast.success("Visibility updated");
      onAuthChanged();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update visibility",
      );
    }
  };

  return (
    <Card className="p-3 space-y-3 h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="size-10 rounded-lg border border-border bg-muted/20 overflow-hidden shrink-0 flex items-center justify-center">
            {icon ? (
              <img
                src={icon}
                alt={title}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <span className="text-xs font-semibold text-muted-foreground">
                {title.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{title}</p>
            <p className="text-xs text-muted-foreground break-all">
              {entry.remoteUrl ?? "-"}
            </p>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <Badge
                variant="outline"
                className={cn("text-[10px]", authBadgeStyle(authStatus))}
              >
                {authBadgeLabel(authStatus)}
              </Badge>
              <Badge
                variant={isPublic ? "default" : "secondary"}
                className="text-[10px]"
              >
                {isPublic ? "Public" : "Not public"}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {isRequestSource ? "Request" : "Store"}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  authFlavor === "server_error"
                    ? "border-destructive/40 text-destructive"
                    : authFlavor === "oauth_connected"
                      ? "border-emerald-500/30 text-emerald-600"
                      : authFlavor === "oauth_available"
                        ? "border-sky-500/30 text-sky-600"
                        : authFlavor === "token_required"
                          ? "border-amber-500/30 text-amber-600"
                          : "text-muted-foreground",
                )}
              >
                {authFlavor === "checking" && "Checking auth..."}
                {authFlavor === "server_error" && "Server error"}
                {authFlavor === "oauth_connected" && "OAuth connected"}
                {authFlavor === "oauth_available" && "OAuth available"}
                {authFlavor === "token_required" && "Token/manual auth"}
                {authFlavor === "connected" && "Connected"}
              </Badge>
              {isUnlisted && (
                <Badge variant="outline" className="text-[10px]">
                  Hidden in private
                </Badge>
              )}
              {(failedResultCount > 0 || failedToolsCount > 0) && (
                <Badge variant="destructive" className="text-[10px]">
                  {failedResultCount} failed MCP / {failedToolsCount} failed
                  tools
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <DotsVertical size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isRequestSource ? (
                <DropdownMenuItem disabled>
                  Request item (no store visibility controls)
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem
                    onClick={() => applyVisibility({ is_public: false })}
                  >
                    Hide from public store
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => applyVisibility({ is_unlisted: true })}
                  >
                    Hide from private store
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      applyVisibility({ is_public: true, is_unlisted: false })
                    }
                  >
                    Show in both stores
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
        {supportsOAuth && (
          <Button size="sm" onClick={handleAuthenticate} disabled={busy}>
            {busy ? "..." : hasOAuthToken ? "Re-auth OAuth" : "OAuth"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => probeQuery.refetch()}
          disabled={busy || isProbeLoading}
        >
          {isProbeLoading ? "Checking..." : "Re-check"}
        </Button>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground">
          Token/API key (for MCPs that require manual auth)
        </p>
        {showMaskedToken ? (
          <div className="relative group">
            <div className="h-8 px-3 flex items-center rounded-md border border-border bg-muted/50 text-muted-foreground font-mono text-xs">
              ••••••••••••••••
            </div>
            <button
              type="button"
              onClick={() => setIsReplacingToken(true)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted"
              title="Replace token"
            >
              Edit
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder="Paste API token / key..."
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSaveToken();
                }
              }}
            />
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={handleSaveToken}
              disabled={busy || !tokenValue.trim()}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => {
                setIsReplacingToken(false);
                setTokenValue("");
              }}
            >
              ✕
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function MonitorConnectionsPanel() {
  const listQuery = useMonitorConnections();
  const runsQuery = useMonitorRuns("completed");
  const latestRun = runsQuery.data?.items?.[0];
  const resultsQuery = useMonitorResults(
    latestRun?.id,
    undefined,
    latestRun?.status,
  );
  const syncMutation = useSyncMonitorConnections();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const items = listQuery.data?.items ?? [];
  const latestResults = resultsQuery.data?.items ?? [];

  const failuresByItem = latestResults.reduce(
    (acc, result) => {
      const current = acc[result.item_id] ?? {
        failedTools: 0,
        failedResults: 0,
      };
      const failedTools = result.tool_results.filter(
        (tool) => !tool.success,
      ).length;
      current.failedTools += failedTools;
      if (result.status === "failed" || result.status === "error") {
        current.failedResults += 1;
      }
      acc[result.item_id] = current;
      return acc;
    },
    {} as Record<string, { failedTools: number; failedResults: number }>,
  );

  const filteredItems = items.filter((entry) => {
    if (sourceFilter === "all") return true;
    return entry.source === sourceFilter;
  });

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">QA Connections</h3>
          <p className="text-[10px] text-muted-foreground">
            We auto-detect auth type. Use OAuth when available, or always paste
            a Token/API key for manual auth MCPs.
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Listing tools alone does not imply authenticated status.
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Cards show MCP icon, auth status, and latest failed test counters.
          </p>
          <div className="mt-2 inline-flex rounded-lg border border-border p-0.5">
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                sourceFilter === "all"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSourceFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                sourceFilter === "store"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSourceFilter("store")}
            >
              Store
            </button>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                sourceFilter === "request"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSourceFilter("request")}
            >
              Requests
            </button>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            syncMutation.mutate(undefined, {
              onSuccess: () =>
                toast.success("Connections synced (store + pending requests)"),
              onError: (err) => toast.error(`Sync failed: ${err.message}`),
            });
          }}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? "Syncing..." : "Sync"}
        </Button>
      </div>
      <div className="space-y-2">
        {filteredItems.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">
            No QA connections for this filter. Click &quot;Sync&quot; to create
            mappings from store items and pending requests.
          </p>
        )}
        {filteredItems.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredItems.map((entry) => {
              const counts = failuresByItem[entry.mapping.item_id] ?? {
                failedTools: 0,
                failedResults: 0,
              };
              return (
                <ConnectionRow
                  key={entry.mapping.id}
                  entry={entry}
                  onAuthChanged={() => listQuery.refetch()}
                  failedToolsCount={counts.failedTools}
                  failedResultCount={counts.failedResults}
                />
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
