import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool, useStudioTools } from "@/lib/studio-tools";
import type { ChatTier } from "@decocms/shared/organization/schema";
import {
  useSimpleMode,
  type ModelSlot,
  type SimpleModeConfig,
} from "./use-organization-settings";

export interface UserModelPreferences {
  tiers: Partial<Record<ChatTier, ModelSlot | null>>;
}

const EMPTY_PREFS: UserModelPreferences = { tiers: {} };

/**
 * The calling user's personal chat tier → model overrides for the current org.
 * Defaults to empty (all tiers fall back to the org config).
 */
export function useUserModelPreferences(): UserModelPreferences {
  const { org } = useProjectContext();
  const { data } = useQuery({
    queryKey: KEYS.userModelPreferences(org.id),
    queryFn: async (): Promise<UserModelPreferences> => {
      try {
        const res = (await callStudioTool(
          org.slug,
          "USER_MODEL_PREFERENCES_GET",
          {},
        )) as UserModelPreferences;
        return res?.tiers ? res : EMPTY_PREFS;
      } catch {
        return EMPTY_PREFS;
      }
    },
    staleTime: 60_000,
  });
  return data ?? EMPTY_PREFS;
}

/**
 * Set a single chat tier's override (null resets it to the org default). Takes
 * one tier at a time and merges optimistically against the cache in `onMutate`
 * — so two quick edits to different tiers chain off each other instead of the
 * second rebuilding from a stale render snapshot and clobbering the first. The
 * server does a full-replace of `tiers`, so `mutationFn` sends the merged cache.
 */
export function useUpdateUserModelPreferences() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const key = KEYS.userModelPreferences(org.id);

  return useMutation({
    mutationFn: async (_patch: { tier: ChatTier; slot: ModelSlot | null }) => {
      // onMutate already merged the patch into the cache — send that.
      const next =
        queryClient.getQueryData<UserModelPreferences>(key) ?? EMPTY_PREFS;
      const payload = (await studio.call(
        "USER_MODEL_PREFERENCES_UPDATE",
        next,
      )) as UserModelPreferences;
      return payload ?? next;
    },
    onMutate: ({ tier, slot }) => {
      const prev = queryClient.getQueryData<UserModelPreferences>(key);
      const base = prev ?? EMPTY_PREFS;
      queryClient.setQueryData<UserModelPreferences>(key, {
        tiers: { ...base.tiers, [tier]: slot },
      });
      return { prev };
    },
    onError: (_err, _patch, ctx) => {
      queryClient.setQueryData(key, ctx?.prev ?? EMPTY_PREFS);
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(key, payload);
    },
  });
}

/**
 * The org tier config with the user's chat-tier overrides layered on top.
 * Mirrors the server-side precedence in `resolveTier` (user → org). Only the
 * three chat tiers are overridable; image/web_search/deep_research pass through
 * unchanged. Both the chat model display and the tier picker read this so the
 * UI matches what a run will actually use.
 */
export function useEffectiveSimpleMode(): SimpleModeConfig {
  const org = useSimpleMode();
  const user = useUserModelPreferences();
  return {
    tiers: {
      ...org.tiers,
      fast: user.tiers.fast ?? org.tiers.fast,
      smart: user.tiers.smart ?? org.tiers.smart,
      thinking: user.tiers.thinking ?? org.tiers.thinking,
    },
  };
}
