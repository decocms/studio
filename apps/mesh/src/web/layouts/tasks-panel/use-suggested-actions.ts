/**
 * useSuggestedActions
 *
 * Reads the last N threads whose most recent message is from the
 * assistant — the "AI spoke last" conversations the user might want
 * to pick back up. `mine` follows the panel's member-filter toggle.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export interface SuggestedAction {
  thread: {
    id: string;
    title: string | null;
    virtual_mcp_id: string | null;
    created_by: string;
    created_at: string;
    updated_at: string;
    trigger_id: string | null;
  };
  agent: {
    id: string;
    name: string;
    icon: string | null;
  } | null;
  description: string;
  excerpt: string;
  last_message_at: string;
}

interface SuggestedActionsResponse {
  suggestions: SuggestedAction[];
}

export function useSuggestedActions(
  orgSlug: string,
  options: { mine: boolean },
) {
  const queryKey = KEYS.suggestedActions(orgSlug, options.mine);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<SuggestedAction[]> => {
      const res = await fetch(
        `/api/${orgSlug}/suggested-actions?mine=${options.mine ? "true" : "false"}`,
      );
      if (!res.ok) throw new Error("Failed to load suggested actions");
      const body = (await res.json()) as SuggestedActionsResponse;
      return body.suggestions;
    },
    // Visibility depends on thread state changing across the app —
    // bypass the global staleTime so window focus always re-fetches
    // and the cards stay fresh without a hard reload.
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  return {
    isLoading: query.isLoading,
    suggestions: query.data ?? [],
  };
}
