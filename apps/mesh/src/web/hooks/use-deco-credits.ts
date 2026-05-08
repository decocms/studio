/**
 * Shared hook for Deco AI Gateway credit balance.
 *
 * Consolidates the balance query used by the sidebar chip, home page,
 * chat error banners, and settings page into a single source of truth.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { useAiProviderKeys } from "./collections/use-ai-providers";
import { track } from "../lib/posthog-client";
import { useRef } from "react";

// Module-level map of last-seen balance per org. Used to detect balance
// increases (heuristic for a completed top-up — we don't have a real
// payment webhook yet). Keyed by orgId so multiple orgs in one session
// don't interfere.
const lastSeenBalance = new Map<string, number>();

export function useDecoCredits() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const keys = useAiProviderKeys();

  const decoKey = keys.find((k) => k.providerId === "deco");

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: KEYS.aiProviderCredits(org.id, "deco"),
    enabled: !!decoKey,
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_CREDITS",
        arguments: { providerId: "deco" },
      })) as {
        structuredContent?: { balanceCents: number };
        isError?: boolean;
      };
      if (result?.isError) return null;
      return result.structuredContent ?? null;
    },
  });

  const balanceCents = data?.balanceCents ?? null;
  const balanceDollars = balanceCents != null ? balanceCents / 100 : null;

  // Heuristic top-up detection: when balance increases between refetches,
  // the most likely cause is a successful top-up via Stripe. This runs at
  // render-time because we don't have a real payment-success webhook yet.
  // Not perfect (could theoretically trigger on admin grants) but catches
  // the common case. Ignores the very first read (undefined → value is not
  // a "top-up", just the initial load).
  const firstSeenRef = useRef<Map<string, boolean>>(new Map());
  if (balanceCents != null) {
    const previous = lastSeenBalance.get(org.id);
    const hasSeenBefore = firstSeenRef.current.get(org.id);
    if (hasSeenBefore && previous != null && balanceCents > previous) {
      track("credits_topped_up_detected", {
        organization_id: org.id,
        delta_cents: balanceCents - previous,
        previous_balance_cents: previous,
        new_balance_cents: balanceCents,
      });
    }
    lastSeenBalance.set(org.id, balanceCents);
    firstSeenRef.current.set(org.id, true);
  }
  const hasDecoKey = !!decoKey;
  const hasCredits = balanceCents != null && balanceCents > 0;
  const isZeroBalance = balanceCents != null && balanceCents === 0;
  const isInitialFreeCredit = balanceCents != null && balanceCents === 200;
  const hasOnlyDecoProvider =
    keys.length > 0 && keys.every((k) => k.providerId === "deco");

  return {
    hasDecoKey,
    decoKeyId: decoKey?.id ?? null,
    balanceCents,
    balanceDollars,
    hasCredits,
    isZeroBalance,
    isInitialFreeCredit,
    hasOnlyDecoProvider,
    isLoading,
    isFetching,
    refetch,
  };
}
