import { KEYS } from "@/web/lib/query-keys";
import { useMCPClient } from "@decocms/mesh-sdk";
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
  const client = useMCPClient({ connectionId, orgId, orgSlug });
  const [error, setError] = useState<string | null>(null);
  const autoResolvedRef = useRef(false);

  // Downstream connection's own configuration_state.
  const stateQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionConfig(orgId, connectionId),
    queryFn: async () => {
      const result = await client.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: connectionId },
      });
      return unwrapToolResult<{ item: DownstreamConnection | null }>(result);
    },
  });

  const currentValue: Record<string, unknown> =
    stateQuery.data?.item?.configuration_state ?? {};
  const configured = isConfigured(currentValue, entry.anchorField);

  // GA: account summaries → grouped options.
  const gaQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryGaSummaries(orgId, connectionId),
    enabled: entry.bindingType === "google-analytics",
    queryFn: async () => {
      const result = await client.callTool({
        name: "get-account-summaries",
        arguments: {},
      });
      return parseAccountSummaries(unwrapToolResult(result));
    },
  });

  // GSC: verified sites (for the Edit select + auto-resolve source).
  const gscQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryGscSites(orgId, connectionId),
    enabled: entry.bindingType === "google-search-console",
    queryFn: async () => {
      const result = await client.callTool({
        name: "list_sites",
        arguments: {},
      });
      return parseListSites(unwrapToolResult<{ sites?: unknown }>(result));
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const merged = mergeConfigState(currentValue, patch);
      const result = await client.callTool({
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

  const save = (patch: Record<string, unknown>) => saveMutation.mutate(patch);

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
        client,
        ctx: { siteHost, connectionId, orgId, orgSlug },
      })
      .then((patch) => {
        if (patch) save(patch);
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
    isLoading: stateQuery.isPending,
  };
}
