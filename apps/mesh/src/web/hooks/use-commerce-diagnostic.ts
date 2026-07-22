/**
 * Shared Commerce Discovery diagnostic read — the two-gate query the home
 * report banner and the task-board paywall banner both need.
 *
 * Gate 1 (cheap, in-house): does this org even have the CD connection? Only orgs
 * that pass it ever open a client to the external CD MCP (gate 2) and read the
 * owner diagnostic. Every failure path degrades to a null diagnostic so a caller
 * renders nothing rather than breaking the page.
 *
 * The returned diagnostic carries run state (`scanned_at`, `run_in_progress`)
 * AND the paywall state (`locked` — true until the org buys the one-time
 * unlock), so callers can gate on either without a second round-trip.
 */
import { useQuery } from "@tanstack/react-query";
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getCommerceDiscoveryAgentId,
  mcpClientQueryOptions,
  SELF_MCP_ALIAS_ID,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { formatPinnedViewTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/routes/commerce-onboarding/companions-core";
import {
  type CommerceDiagnosticRunState,
  deriveCommerceReportBannerStatus,
} from "./commerce-diagnostic-status";

/** Poll cadence while a run is live; a run takes minutes, not seconds. */
const GENERATING_POLL_MS = 20_000;

interface ConnectionItem {
  metadata?: Record<string, unknown> | null;
}

function hostFromSiteUrl(siteUrl: unknown): string | null {
  if (typeof siteUrl !== "string" || !siteUrl) return null;
  try {
    return new URL(siteUrl).hostname || null;
  } catch {
    return null;
  }
}

/** Minimal shape of the Commerce Discovery MCP client we use — enough to call
 *  a tool (e.g. start_checkout) without pulling the full SDK client type in. */
export interface CommerceDiscoveryClient {
  callTool: (input: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
}

export interface UseCommerceDiagnosticResult {
  /** The owner diagnostic, or null (no CD connection, never run, or an error). */
  diagnostic: CommerceDiagnosticRunState | null;
  /** True once the diagnostic query has resolved (vs still loading / disabled). */
  isSuccess: boolean;
  /** The store's hostname from the connection metadata, for copy. */
  host: string | null;
  connectionId: string;
  /** The CD MCP client (once gate 2 opens), for tool calls like start_checkout. */
  cdClient: CommerceDiscoveryClient | null;
}

export function useCommerceDiagnostic(): UseCommerceDiagnosticResult {
  const { org } = useProjectContext();
  const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);

  const { data: selfClient } = useQuery(
    mcpClientQueryOptions({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  );

  // Gate 1: does this org have the CD connection at all? Same key + shape as the
  // onboarding query, so the caches cooperate.
  const connectionQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryConnection(org.id, connectionId),
    enabled: !!selfClient,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      if (!selfClient) throw new Error("selfClient not ready");
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: connectionId },
      });
      return unwrapToolResult<{ item: ConnectionItem | null }>(result);
    },
  });
  const connectionItem = connectionQuery.data?.item ?? null;

  // Gate 2: only orgs that passed gate 1 open a client to the CD MCP.
  const { data: cdClient } = useQuery({
    ...mcpClientQueryOptions({
      connectionId,
      orgId: org.id,
      orgSlug: org.slug,
    }),
    enabled: !!connectionItem,
  });

  const diagnosticQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryDiagnostic(org.id, connectionId),
    enabled: !!cdClient,
    retry: 1,
    refetchInterval: (query) =>
      query.state.status !== "error" &&
      deriveCommerceReportBannerStatus(query.state.data) === "generating"
        ? GENERATING_POLL_MS
        : false,
    queryFn: async () => {
      if (!cdClient) throw new Error("cdClient not ready");
      const result = await cdClient.callTool({
        name: COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
        arguments: {},
      });
      const parsed = unwrapToolResult<{
        diagnostic?: CommerceDiagnosticRunState | null;
      }>(result);
      return parsed.diagnostic ?? null;
    },
  });

  return {
    diagnostic: diagnosticQuery.data ?? null,
    isSuccess: diagnosticQuery.isSuccess,
    host: hostFromSiteUrl(connectionItem?.metadata?.siteUrl),
    connectionId,
    cdClient: (cdClient as CommerceDiscoveryClient | undefined) ?? null,
  };
}

/** Navigate args that open the Commerce Discovery report app (where the unlock /
 *  checkout lives) as a pinned view on a fresh thread. Shared by the home banner
 *  and the board paywall so the target stays identical. */
export function commerceReportNavTarget(
  org: { id: string; slug: string },
  connectionId: string,
) {
  return {
    to: "/$org/$taskId" as const,
    params: { org: org.slug, taskId: crypto.randomUUID() },
    search: {
      virtualmcpid: getCommerceDiscoveryAgentId(org.id),
      main: formatPinnedViewTabId(
        connectionId,
        COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
      ),
    },
  };
}
