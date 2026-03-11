/**
 * AI Provider Hooks
 *
 * React hooks for the AI provider key management UI (settings page).
 * Uses MCP tools via the mesh-sdk client.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type AiProviderModel as BaseAiProviderModel,
  type AiProviderKey,
} from "@decocms/mesh-sdk";

export type { AiProviderKey };

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";

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

export interface AiProviderModel extends BaseAiProviderModel {
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

  const { data } = useQuery({
    queryKey: KEYS.aiProviderModels(locator, keyId ?? ""),
    enabled: !!keyId,
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

export function useSuspenseAiProviderModels(keyId: string) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.aiProviderModels(locator, keyId),
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
