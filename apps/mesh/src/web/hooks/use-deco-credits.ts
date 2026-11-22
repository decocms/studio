/**
 * Shared hook for Deco AI Gateway credit balance.
 *
 * Consolidates the balance query used by the sidebar chip, home page,
 * chat error banners, and settings page into a single source of truth.
 */

import { createContext, useContext } from "react";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { useAiProviderKeys } from "./collections/use-ai-providers";

export interface DecoCreditsData {
  hasDecoKey: boolean;
  decoKeyId: string | null;
  balanceCents: number | null;
  balanceDollars: number | null;
  hasCredits: boolean;
  isZeroBalance: boolean;
  isInitialFreeCredit: boolean;
  hasOnlyDecoProvider: boolean;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
  /** When true, UI should skip localStorage/chat-empty guards (demo toolbar). */
  isDemoOverride?: boolean;
}

/** When set, useDecoCredits() returns this override instead of real data. */
export const DecoCreditsOverrideContext = createContext<DecoCreditsData | null>(
  null,
);

export function useDecoCredits(): DecoCreditsData {
  const override = useContext(DecoCreditsOverrideContext);
  const real = useDecoCreditsReal();
  return override ?? real;
}

function useDecoCreditsReal() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
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
