import { useState } from "react";
import {
  authenticateMcp,
  isConnectionAuthenticated,
  UI_RESOURCE_HTML_KEY,
  useProjectContext,
} from "@/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clearHtmlResourceCacheForConnection } from "@/lib/html-resource-persist";
import { useStudioTools } from "@/lib/studio-tools";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { toast } from "sonner";
import {
  useSyncMonitorConnections,
  useMonitorConnections,
  useMonitorResults,
  useMonitorRuns,
  useUpdateMonitorConnectionAuth,
} from "@/hooks/registry/use-monitor";
import { KEYS } from "@/lib/registry/query-keys";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useRegistryMutations } from "@/hooks/registry/use-registry";
import { useT } from "@/i18n/use-t.ts";
import type {
  MonitorConnectionAuthStatus,
  MonitorConnectionListItem,
} from "@/lib/registry/types";
import { DotsVertical } from "@untitledui/icons";

type SourceFilter = "all" | "store" | "request";

function authBadgeStyle(status: MonitorConnectionAuthStatus) {
  switch (status) {
    case "authenticated":
      return "bg-success/10 text-success border-success/20";
    case "needs_auth":
      return "bg-warning/10 text-warning border-warning/20";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function authBadgeLabel(
  status: MonitorConnectionAuthStatus,
  t: ReturnType<typeof useT>,
) {
  switch (status) {
    case "authenticated":
      return t("registry.monitorConnectionsPanel.authenticated");
    case "needs_auth":
      return t("registry.monitorConnectionsPanel.needsAuth");
    default:
      return t("registry.monitorConnectionsPanel.notChecked");
  }
}

export function ConnectionIcon({
  icon,
  title,
}: {
  icon: string | null;
  title: string;
}) {
  const [iconFailed, setIconFailed] = useState(false);

  return (
    <div className="size-10 rounded-lg border border-border bg-muted/20 overflow-hidden shrink-0 flex items-center justify-center">
      {icon && !iconFailed ? (
        <img
          src={icon}
          alt={title}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setIconFailed(true)}
        />
      ) : (
        <span className="text-xs font-semibold text-muted-foreground">
          {title.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
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

  const t = useT();
  const updateAuth = useUpdateMonitorConnectionAuth();
  const { updateMutation } = useRegistryMutations();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const connectionId = entry.mapping.connection_id;
  const authStatus = entry.mapping.auth_status;
  const title = entry.item?.title ?? entry.mapping.item_id;
  const icon = entry.item?.server?.icons?.[0]?.src ?? null;
  const isPublic = entry.item?.is_public ?? false;
  const isUnlisted = entry.item?.is_unlisted ?? false;
  const isRequestSource = entry.source === "request";
  const probeQuery = useQuery({
    queryKey: KEYS.monitorConnectionAuthProbe(org.id, connectionId),
    queryFn: async () =>
      isConnectionAuthenticated({
        url: `/api/${org.slug}/mcp/${connectionId}`,
        token: null,
        orgId: org.id,
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
  // A non-server-error `error` means the probe request itself failed (network,
  // DNS, CORS) — distinct from "not authenticated yet", which otherwise falls
  // through to the misleading "token required" flavor below.
  const probeError = !isServerError ? probeResult?.error : undefined;
  const authFlavor = isProbeLoading
    ? "checking"
    : isServerError
      ? "server_error"
      : probeError
        ? "unreachable"
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
      {
        onSuccess: () => {
          onAuthChanged();
          // Auth changed → upstream may return different content; drop cached
          // UI HTML for this connection (IDB + in-memory query) so it re-reads
          // fresh, regardless of whether auth happened via OAuth or a token.
          void clearHtmlResourceCacheForConnection(connectionId);
          queryClient.invalidateQueries({
            predicate: (query) =>
              query.queryKey[1] === UI_RESOURCE_HTML_KEY &&
              query.queryKey[3] === connectionId,
          });
        },
        onError: (err) =>
          toast.error(
            t("registry.monitorConnectionsPanel.failedToSaveAuthStatus", {
              title,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
      },
    );
  };

  const handleAuthenticate = async () => {
    setBusy(true);
    try {
      // Recheck before choosing OAuth vs token guidance
      const probe = await probeQuery.refetch();
      const status = probe.data;
      if (!status) {
        toast.error(
          t("registry.monitorConnectionsPanel.couldNotReachConnection", {
            title,
          }),
        );
        return;
      }

      if (status.isAuthenticated) {
        toast.success(
          t("registry.monitorConnectionsPanel.connectionReachable", { title }),
        );
        return;
      }

      if (status.isServerError) {
        toast.error(
          t("registry.monitorConnectionsPanel.serverErrorConnection", {
            title,
          }),
        );
        return;
      }

      if (status.error) {
        toast.error(
          t("registry.monitorConnectionsPanel.connectionUnreachable", {
            title,
            error: status.error,
          }),
        );
        return;
      }

      if (!status.supportsOAuth) {
        toast.warning(
          t("registry.monitorConnectionsPanel.noOAuthSupport", { title }),
        );
        return;
      }

      // Server supports OAuth — trigger the flow
      toast.info(
        t("registry.monitorConnectionsPanel.openingAuthWindow", { title }),
      );
      const authResult = await authenticateMcp({
        connectionId,
        orgSlug: org.slug,
        clientName: `MCP Test - ${title}`,
        timeout: 180000,
      });

      if (authResult.error) {
        toast.error(
          t("registry.monitorConnectionsPanel.oauthFailed", {
            title,
            error: authResult.error,
          }),
        );
        return;
      }

      // Save OAuth tokens
      if (authResult.tokenInfo) {
        const res = await fetch(
          `/api/${org.slug}/connections/${connectionId}/oauth-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
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
          } else {
            toast.error(
              t("registry.monitorConnectionsPanel.failedToSaveOAuthTokens", {
                title,
              }),
            );
            return;
          }
        }
      } else if (authResult.token) {
        await saveTokenInternal(authResult.token);
      }

      toast.success(
        t("registry.monitorConnectionsPanel.connectionAuthenticated", {
          title,
        }),
      );
      markAuthenticated();
      await probeQuery.refetch();
    } catch (err) {
      console.error("[MonitorConnectionsPanel] Auth error:", err);
      toast.error(
        t("registry.monitorConnectionsPanel.authError", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const saveTokenInternal = async (token: string) => {
    await studio.call("COLLECTION_CONNECTIONS_UPDATE", {
      id: connectionId,
      data: { connection_token: token },
    });
  };

  const handleSaveToken = async () => {
    if (!tokenValue.trim()) {
      toast.error(t("registry.monitorConnectionsPanel.tokenCannotBeEmpty"));
      return;
    }
    setBusy(true);
    try {
      await saveTokenInternal(tokenValue);
      toast.success(
        t("registry.monitorConnectionsPanel.tokenSaved", { title }),
      );
      setIsReplacingToken(false);
      setTokenValue("");
      markAuthenticated();
      await probeQuery.refetch();
    } catch (err) {
      toast.error(
        t("registry.monitorConnectionsPanel.errorSavingToken", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const showMaskedToken =
    !isProbeLoading &&
    authStatus === "authenticated" &&
    !hasOAuthToken &&
    !isReplacingToken &&
    tokenValue.length === 0;
  const isCheckingTokenField =
    isProbeLoading &&
    authStatus === "authenticated" &&
    !isReplacingToken &&
    tokenValue.length === 0;
  const applyVisibility = async (patch: {
    is_public?: boolean;
    is_unlisted?: boolean;
  }) => {
    if (isRequestSource) {
      toast.info(t("registry.monitorConnectionsPanel.visibilityOnlyForStore"));
      return;
    }
    if (!entry.item) {
      toast.error(t("registry.monitorConnectionsPanel.registryItemNotFound"));
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: entry.item.id,
        data: patch,
      });
      toast.success(t("registry.monitorConnectionsPanel.visibilityUpdated"));
      onAuthChanged();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("registry.monitorConnectionsPanel.failedToUpdateVisibility"),
      );
    }
  };

  return (
    <Card className="p-3 space-y-3 h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          {/* Remount on icon URL change so a prior load failure doesn't stick
              around as a permanent fallback once a new icon is synced in. */}
          <ConnectionIcon key={icon ?? title} icon={icon} title={title} />
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
                {authBadgeLabel(authStatus, t)}
              </Badge>
              <Badge
                variant={isPublic ? "default" : "secondary"}
                className="text-[10px]"
              >
                {isPublic
                  ? t("registry.monitorConnectionsPanel.public")
                  : t("registry.monitorConnectionsPanel.notPublic")}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {isRequestSource
                  ? t("registry.monitorConnectionsPanel.request")
                  : t("registry.monitorConnectionsPanel.store")}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  authFlavor === "server_error" || authFlavor === "unreachable"
                    ? "border-destructive/40 text-destructive"
                    : authFlavor === "oauth_connected"
                      ? "border-success/30 text-success"
                      : authFlavor === "oauth_available"
                        ? "border-sky-500/30 text-sky-600"
                        : authFlavor === "token_required"
                          ? "border-warning/30 text-warning"
                          : "text-muted-foreground",
                )}
              >
                {authFlavor === "checking" &&
                  t("registry.monitorConnectionsPanel.checkingAuth")}
                {authFlavor === "server_error" &&
                  t("registry.monitorConnectionsPanel.serverError")}
                {authFlavor === "unreachable" &&
                  t("registry.monitorConnectionsPanel.unreachable")}
                {authFlavor === "oauth_connected" &&
                  t("registry.monitorConnectionsPanel.oauthConnected")}
                {authFlavor === "oauth_available" &&
                  t("registry.monitorConnectionsPanel.oauthAvailable")}
                {authFlavor === "token_required" &&
                  t("registry.monitorConnectionsPanel.tokenManualAuth")}
                {authFlavor === "connected" &&
                  t("registry.monitorConnectionsPanel.connected")}
              </Badge>
              {isUnlisted && (
                <Badge variant="outline" className="text-[10px]">
                  {t("registry.monitorConnectionsPanel.hiddenInPrivate")}
                </Badge>
              )}
              {(failedResultCount > 0 || failedToolsCount > 0) && (
                <Badge variant="destructive" className="text-[10px]">
                  {t("registry.monitorConnectionsPanel.failedCount", {
                    mcpCount: failedResultCount,
                    toolsCount: failedToolsCount,
                  })}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                aria-label={t("registry.monitorConnectionsPanel.actionsFor", {
                  title,
                })}
              >
                <DotsVertical size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isRequestSource ? (
                <DropdownMenuItem disabled>
                  {t("registry.monitorConnectionsPanel.requestItemNoControls")}
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem
                    onClick={() => applyVisibility({ is_public: false })}
                  >
                    {t("registry.monitorConnectionsPanel.hideFromPublicStore")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => applyVisibility({ is_unlisted: true })}
                  >
                    {t("registry.monitorConnectionsPanel.hideFromPrivateStore")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      applyVisibility({ is_public: true, is_unlisted: false })
                    }
                  >
                    {t("registry.monitorConnectionsPanel.showInBothStores")}
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
            {busy
              ? "..."
              : hasOAuthToken
                ? t("registry.monitorConnectionsPanel.reAuthOAuth")
                : t("registry.monitorConnectionsPanel.oauth")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => probeQuery.refetch()}
          disabled={busy || isProbeLoading}
        >
          {isProbeLoading
            ? t("registry.monitorConnectionsPanel.checking")
            : t("registry.monitorConnectionsPanel.reCheck")}
        </Button>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground">
          {t("registry.monitorConnectionsPanel.tokenApiKeyDescription")}
        </p>
        {isCheckingTokenField ? (
          <div className="h-8 px-3 flex items-center rounded-md border border-border bg-muted/30 text-muted-foreground text-xs">
            {t("registry.monitorConnectionsPanel.checkingAuth")}
          </div>
        ) : showMaskedToken ? (
          <div className="relative group">
            <div className="h-8 px-3 flex items-center rounded-md border border-border bg-muted/50 text-muted-foreground font-mono text-xs">
              ••••••••••••••••
            </div>
            <button
              type="button"
              onClick={() => setIsReplacingToken(true)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted"
              title={t("registry.monitorConnectionsPanel.replaceToken")}
            >
              {t("registry.monitorConnectionsPanel.edit")}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder={t(
                "registry.monitorConnectionsPanel.pasteApiTokenPlaceholder",
              )}
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy && tokenValue.trim()) {
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
              {t("registry.monitorConnectionsPanel.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              aria-label={t(
                "registry.monitorConnectionsPanel.cancelReplaceToken",
              )}
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
  const t = useT();
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
          <h3 className="text-sm font-semibold">
            {t("registry.monitorConnectionsPanel.title")}
          </h3>
          <p className="text-[10px] text-muted-foreground">
            {t("registry.monitorConnectionsPanel.description1")}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {t("registry.monitorConnectionsPanel.description2")}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {t("registry.monitorConnectionsPanel.description3")}
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
              {t("registry.monitorConnectionsPanel.filterAll")}
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
              {t("registry.monitorConnectionsPanel.filterStore")}
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
              {t("registry.monitorConnectionsPanel.filterRequests")}
            </button>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            syncMutation.mutate(undefined, {
              onSuccess: () =>
                toast.success(
                  t("registry.monitorConnectionsPanel.connectionsSynced"),
                ),
              onError: (err) =>
                toast.error(
                  t("registry.monitorConnectionsPanel.syncFailed", {
                    error: err.message,
                  }),
                ),
            });
          }}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending
            ? t("registry.monitorConnectionsPanel.syncing")
            : t("registry.monitorConnectionsPanel.sync")}
        </Button>
      </div>
      <div className="space-y-2">
        {listQuery.isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-3">
            {t("registry.monitorConnectionsPanel.loadingConnections")}
          </p>
        ) : listQuery.isError ? (
          <div className="p-8 text-center rounded-lg border border-border">
            <p className="text-sm text-destructive">
              {t("registry.monitorConnectionsPanel.loadFailed")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : t("registry.monitorConnectionsPanel.unknownError")}
            </p>
          </div>
        ) : (
          filteredItems.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">
              {t("registry.monitorConnectionsPanel.noConnectionsForFilter")}
            </p>
          )
        )}
        {!listQuery.isLoading &&
          !listQuery.isError &&
          filteredItems.length > 0 && (
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
