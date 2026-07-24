/**
 * LLM Collection Hooks
 *
 * Provides React hooks for working with LLM models from remote connections
 * using React Query.
 */

import type { ModelCollectionEntitySchema } from "@decocms/bindings/llm";
import {
  useProjectContext,
  type AiProviderModel,
  type AiProviderKey,
  type AiProviderInfo,
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
