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
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";

/**
 * Query options for the org's AI provider keys. Shared with parallel-prefetch
 * batches so they warm the exact cache entry useAiProviderKeys reads.
 */
export function aiProviderKeysQueryOptions(client: Client, orgId: string) {
  return {
    queryKey: KEYS.aiProviderKeys(orgId),
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
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviders(org.id),
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

export function useAiProviderKeys() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useSuspenseQuery(aiProviderKeysQueryOptions(client, org.id));
  return data?.keys ?? [];
}

export function useAiProviderModels(keyId: string | undefined) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isLoading } = useQuery({
    queryKey: KEYS.aiProviderModels(org.id, keyId ?? ""),
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
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderModels(org.id, keyId),
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
