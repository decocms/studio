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
export function useUserModelPreferencesQuery() {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.userModelPreferences(org.id),
    queryFn: async (): Promise<UserModelPreferences> => {
      // Deliberately not catching: swallowing a read failure would show
      // "Using organization default" while a run uses the stored override —
      // the exact display/reality gap this feature exists to close. The tool
      // returns `{ tiers: {} }` when there's no row, so an error is a real one.
      const res = (await callStudioTool(
        org.slug,
        "USER_MODEL_PREFERENCES_GET",
        {},
      )) as UserModelPreferences;
      return res?.tiers ? res : EMPTY_PREFS;
    },
    staleTime: 60_000,
  });
}

/** The overrides themselves. See `useUserModelPreferencesQuery` for load state. */
function useUserModelPreferences(): UserModelPreferences {
  return useUserModelPreferencesQuery().data ?? EMPTY_PREFS;
}

/**
 * Set a single chat tier's override (null resets it to the org default). Takes
 * one tier at a time and merges optimistically against the cache in `onMutate`
 * — so two quick edits to different tiers chain off each other instead of the
 * second rebuilding from a stale render snapshot and clobbering the first. The
 * server does a full-replace of `tiers`, so `mutationFn` sends the merged cache.
 *
 * `onSuccess` writing the response back is still not enough on its own: if two
 * responses land out of order, the older payload wins and the cache disagrees
 * with the server for a full `staleTime`. `onSettled` refetches to settle it.
 */
export function useUpdateUserModelPreferences() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const key = KEYS.userModelPreferences(org.id);

  return useMutation({
    mutationKey: key,
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
    onSettled: () => {
      // Only the last edit standing refetches — invalidating while a sibling
      // tier's write is still in flight would drop its optimistic value.
      if (queryClient.isMutating({ mutationKey: key }) === 1) {
        queryClient.invalidateQueries({ queryKey: key });
      }
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
