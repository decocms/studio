/**
 * LLM Collection Hooks
 *
 * Provides React hooks for working with LLM models from remote connections
 * using React Query.
 */

import type { ModelCollectionEntitySchema } from "@decocms/bindings/llm";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type AiProviderModel,
  type AiProviderKey,
  type AiProviderInfo,
  type UseCollectionListOptions,
} from "@decocms/mesh-sdk";

export type { AiProviderKey, AiProviderModel, AiProviderInfo };
import { z } from "zod";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";

// LLM type matching ModelSchema from @decocms/bindings
export type LLM = z.infer<typeof ModelCollectionEntitySchema>;

/**
 * Options for useLLMsFromConnection hook
 */
export type UseLLMsOptions = UseCollectionListOptions<LLM>;

export function useAiProviders() {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviders(locator),
    staleTime: Infinity,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDERS_LIST",
        arguments: {},
      })) as {
        structuredContent?: { providers: AiProviderInfo[] };
      };
      return result.structuredContent;
    },
  });
  return data;
}

export function useAiProviderKeyList() {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderKeys(locator),
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_KEY_LIST",
        arguments: {},
      })) as {
        structuredContent?: { keys: AiProviderKey[] };
      };
      return result.structuredContent ?? null;
    },
  });
  return data?.keys ?? [];
}

export function useAiProviderModels(keyId: string | undefined) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data, isLoading } = useQuery({
    queryKey: KEYS.aiProviderModels(locator, keyId ?? ""),
    enabled: !!keyId,
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDERS_LIST_MODELS",
        arguments: { keyId },
      })) as {
        structuredContent?: { models: AiProviderModel[] };
      };
      return result.structuredContent ?? null;
    },
  });
  return { models: data?.models ?? [], isLoading: !!keyId && isLoading };
}

export function useSuspenseAiProviderModels(keyId: string) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderModels(locator, keyId),
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDERS_LIST_MODELS",
        arguments: { keyId },
      })) as {
        structuredContent?: { models: AiProviderModel[] };
      };
      return result.structuredContent ?? null;
    },
  });
  return data?.models ?? [];
}
