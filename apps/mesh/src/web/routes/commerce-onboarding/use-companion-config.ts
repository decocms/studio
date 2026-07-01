import { KEYS } from "@/web/lib/query-keys";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  type GaPropertyGroup,
  type VerifiedSite,
  isConfigured,
  mergeConfigState,
  parseAccountSummaries,
  parseListSites,
} from "./companion-config-core.ts";
import type { CompanionConfigEntry } from "./companion-config-registry.ts";
import { unwrapToolResult } from "./companions-core.ts";

interface DownstreamConnection {
  configuration_state?: Record<string, unknown> | null;
}

export function useCompanionConfig({
  entry,
  connectionId,
  orgId,
  orgSlug,
  siteHost,
}: {
  entry: CompanionConfigEntry;
  connectionId: string;
  orgId: string;
  orgSlug: string;
  siteHost: string | null;
}) {
  const queryClient = useQueryClient();
  // Two clients: the SELF/management MCP serves the COLLECTION_CONNECTIONS_*
  // tools (reading/writing the connection row), while the downstream connection
  // serves its own data tools (get-account-summaries / list_sites). The GA/VTEX
  // MCP servers do NOT expose the management collection tools.
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });
  const downstreamClient = useMCPClient({ connectionId, orgId, orgSlug });
  const [error, setError] = useState<string | null>(null);
  const autoResolvedRef = useRef(false);

  // Downstream connection's own configuration_state (management tool → self).
  const stateQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionConfig(orgId, connectionId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: connectionId },
      });
      return unwrapToolResult<{ item: DownstreamConnection | null }>(result);
    },
  });

  const currentValue: Record<string, unknown> =
    stateQuery.data?.item?.configuration_state ?? {};
  const configured = isConfigured(currentValue, entry.anchorField);

  // GA: account summaries → grouped options (downstream data tool).
  const gaQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryGaSummaries(orgId, connectionId),
    enabled: entry.bindingType === "google-analytics",
    queryFn: async () => {
      const result = await downstreamClient.callTool({
        name: "get-account-summaries",
        arguments: {},
      });
      return parseAccountSummaries(unwrapToolResult(result));
    },
  });

  // GSC: verified sites for the Edit select + auto-resolve source (downstream).
  const gscQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryGscSites(orgId, connectionId),
    enabled: entry.bindingType === "google-search-console",
    queryFn: async () => {
      const result = await downstreamClient.callTool({
        name: "list_sites",
        arguments: {},
      });
      return parseListSites(unwrapToolResult(result));
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const merged = mergeConfigState(currentValue, patch);
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_UPDATE",
        arguments: { id: connectionId, data: { configuration_state: merged } },
      });
      return unwrapToolResult<{ item: unknown }>(result);
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConfig(orgId, connectionId),
      });
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : String(err)),
  });

  // Returns whether the save succeeded so callers can defer collapsing the
  // edit form until the write is durably persisted (keeps the form + error
  // visible on failure).
  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    try {
      await saveMutation.mutateAsync(patch);
      return true;
    } catch {
      return false;
    }
  };

  // One-shot auto-resolve (GSC), fired from a callback ref on the section root
  // (not during render — the .current guard lives inside this function, which
  // runs after commit). Mirrors triggerInitialSetup in commerce-onboarding.tsx;
  // useEffect and render-time ref access are both banned in this app.
  const maybeAutoResolve = (node: HTMLElement | null) => {
    if (
      !node ||
      autoResolvedRef.current ||
      !entry.autoResolve ||
      configured ||
      stateQuery.isPending ||
      saveMutation.isPending
    ) {
      return;
    }
    autoResolvedRef.current = true;
    void entry
      .autoResolve({
        client: downstreamClient,
        ctx: { siteHost, connectionId, orgId, orgSlug },
      })
      .then((patch) => {
        if (patch) void save(patch);
      })
      .catch(() => {
        /* non-blocking: user can still fill via the Edit escape hatch */
      });
  };

  return {
    configured,
    currentValue,
    gaGroups: (gaQuery.data ?? []) as GaPropertyGroup[],
    gaError: !!gaQuery.error,
    verifiedSites: (gscQuery.data ?? []) as VerifiedSite[],
    saving: saveMutation.isPending,
    error,
    save,
    maybeAutoResolve,
    // Hold the renderer until the MCP-specific data it initializes from (GA
    // grouped options / GSC verified sites) is ready too — otherwise the GA
    // card would mount on the manual-fallback branch and miss single-property
    // auto-select. gaQuery/gscQuery are only consulted for their own binding
    // (both are `enabled`-gated, so isPending is meaningful there).
    isLoading:
      stateQuery.isPending ||
      (entry.bindingType === "google-analytics" && gaQuery.isPending) ||
      (entry.bindingType === "google-search-console" && gscQuery.isPending),
  };
}
