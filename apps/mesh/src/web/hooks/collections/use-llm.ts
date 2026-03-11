/**
 * LLM Collection Hooks
 *
 * Provides React hooks for working with LLM models from remote connections
 * using React Query.
 */

import type { ModelCollectionEntitySchema } from "@decocms/bindings/llm";
import {
  SELF_MCP_ALIAS_ID,
  useCollectionList,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
  type AiProviderModel as BaseAiProviderModel,
  type AiProviderKey,
  type UseCollectionListOptions,
} from "@decocms/mesh-sdk";

export type { AiProviderKey };
import { z } from "zod";
import { useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";

// LLM type matching ModelSchema from @decocms/bindings
export type LLM = z.infer<typeof ModelCollectionEntitySchema>;

/**
 * Options for useLLMsFromConnection hook
 */
export type UseLLMsOptions = UseCollectionListOptions<LLM>;

/**
 * Hook to get all LLM models from a specific connection
 *
 * @param connectionId - The ID of the connection to fetch LLMs from
 * @param options - Filter and configuration options
 * @returns Suspense query result with LLMs
 */
export function useLLMsFromConnection(
  connectionId: string | undefined,
  options: UseLLMsOptions = {},
) {
  const { org } = useProjectContext();
  const client = useMCPClientOptional({
    connectionId,
    orgId: org.id,
  });
  const scopeKey = connectionId ?? "no-connection";
  return useCollectionList<LLM>(scopeKey, "LLM", client, options);
}

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
        structuredContent?: {
          providers: {
            id: string;
            name: string;
            description: string;
            logo: string | null;
            connectionMethod: "api-key" | "oauth-pkce";
            supportedMethods: ("api-key" | "oauth-pkce")[];
          }[];
        };
      };
      return result.structuredContent;
    },
  });
  return data;
}

/** Shape returned by AI_PROVIDERS_LIST_MODELS — extends the shared base with client-side keyId. */
export interface AiProviderModel extends BaseAiProviderModel {
  /** Key ID used to fetch this model — populated client-side on model selection. */
  keyId?: string;
}

export function useAiProviderKeyList() {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderKeys(locator),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_KEY_LIST",
        arguments: {},
      })) as {
        structuredContent?: { keys: AiProviderKey[] };
      };
      return result.structuredContent;
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

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderModels(locator, keyId ?? ""),
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
