/**
 * LLM Collection Hooks
 *
 * Provides React hooks for working with LLM models from remote connections
 * using React Query.
 */

import type { ModelCollectionEntitySchema } from "@decocms/bindings/llm";
import {
  useProjectContext,
  pickSimpleModeDefaults,
  type AiProviderModel,
  type AiProviderKey,
  type AiProviderInfo,
  type SimpleModeDefaults,
  type UseCollectionListOptions,
} from "@/sdk";

export type { AiProviderKey, AiProviderModel, AiProviderInfo };
import { z } from "zod";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";
import { callStudioTool, useStudioTools } from "../../lib/studio-tools";

/**
 * Query options for the org's AI provider keys. Shared with parallel-prefetch
 * batches so they warm the exact cache entry useAiProviderKeys reads.
 */
function aiProviderKeysQueryOptions(orgSlug: string, orgId: string) {
  return {
    queryKey: KEYS.aiProviderKeys(orgId),
    staleTime: 60_000,
    queryFn: async () =>
      (await callStudioTool(orgSlug, "AI_PROVIDER_KEY_LIST", {})) as {
        keys: AiProviderKey[];
      },
  };
}

// LLM type matching ModelSchema from @decocms/bindings
export type LLM = z.infer<typeof ModelCollectionEntitySchema>;

/**
 * Options for useLLMsFromConnection hook
 */
export type UseLLMsOptions = UseCollectionListOptions<LLM>;

export function useAiProviders() {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviders(org.id),
    staleTime: Infinity,
    queryFn: async () =>
      (await studio.call("AI_PROVIDERS_LIST", {})) as {
        providers: AiProviderInfo[];
      },
  });
  return data;
}

export function useAiProviderKeys() {
  const { org } = useProjectContext();
  const { data } = useSuspenseQuery(
    aiProviderKeysQueryOptions(org.slug, org.id),
  );
  return data?.keys ?? [];
}

export function useAiProviderModels(keyId: string | undefined) {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data, isLoading } = useQuery({
    queryKey: KEYS.aiProviderModels(org.id, keyId ?? ""),
    enabled: !!keyId,
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("AI_PROVIDERS_LIST_MODELS", {
        keyId: keyId ?? "",
      })) as { models: AiProviderModel[] },
  });
  return { models: data?.models ?? [], isLoading: !!keyId && isLoading };
}

/**
 * Mirrors the server's tier auto-pick (`pickSimpleModeDefaults`) so a UI
 * showing "what model will this tier use" agrees with what a run actually
 * gets. Hooks can't loop over an arbitrary key count, so this caps at the
 * first 3 keys — same tradeoff `SimpleModeSection` already makes to prefill
 * the settings form; picking only `keys[0]` (the previous shortcut here)
 * showed the wrong provider's catalog whenever the org's first key wasn't
 * the one the backend would actually select for a tier.
 */
export function useAutoSimpleModeDefaults(
  keys: AiProviderKey[],
): SimpleModeDefaults {
  const key0 = keys[0];
  const key1 = keys[1];
  const key2 = keys[2];
  const { models: models0 } = useAiProviderModels(key0?.id);
  const { models: models1 } = useAiProviderModels(key1?.id);
  const { models: models2 } = useAiProviderModels(key2?.id);
  const modelsByKeyId: Record<string, AiProviderModel[]> = {};
  if (key0?.id) modelsByKeyId[key0.id] = models0;
  if (key1?.id) modelsByKeyId[key1.id] = models1;
  if (key2?.id) modelsByKeyId[key2.id] = models2;
  return pickSimpleModeDefaults(keys, modelsByKeyId);
}

export function useSuspenseAiProviderModels(keyId: string) {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderModels(org.id, keyId),
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("AI_PROVIDERS_LIST_MODELS", { keyId })) as {
        models: AiProviderModel[];
      },
  });
  return data?.models ?? [];
}
