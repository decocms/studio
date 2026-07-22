import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export interface ApiKey {
  id: string;
  name: string;
  userId: string;
  permissions: Record<string, string[]>;
  expiresAt?: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

interface ToolEnvelope<T> {
  structuredContent?: T;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

function unwrap<T>(result: ToolEnvelope<T>, fallbackMessage: string): T {
  if (result?.isError) {
    throw new Error(result.content?.[0]?.text ?? fallbackMessage);
  }
  if (!result.structuredContent) {
    throw new Error(fallbackMessage);
  }
  return result.structuredContent;
}

export function useApiKeysList(): UseQueryResult<ApiKey[]> {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.apiKeysList(org.id),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "API_KEY_LIST",
        arguments: {},
      })) as ToolEnvelope<{ items: ApiKey[] }>;
      return unwrap(result, "Failed to list API keys").items;
    },
    staleTime: 30_000,
  });
}

export function useCreateApiKey(): UseMutationResult<
  CreatedApiKey,
  Error,
  { name: string; permissions?: Record<string, string[]> }
> {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input) => {
      const result = (await client.callTool({
        name: "API_KEY_CREATE",
        arguments: {
          name: input.name,
          permissions: input.permissions ?? { "*": ["*"] },
        },
      })) as ToolEnvelope<CreatedApiKey>;
      return unwrap(result, "Failed to create API key");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.apiKeysList(org.id) });
    },
  });
}

export function useDeleteApiKey(): UseMutationResult<
  { success: boolean; keyId: string },
  Error,
  string
> {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (keyId) => {
      const result = (await client.callTool({
        name: "API_KEY_DELETE",
        arguments: { keyId },
      })) as ToolEnvelope<{ success: boolean; keyId: string }>;
      return unwrap(result, "Failed to delete API key");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.apiKeysList(org.id) });
    },
  });
}
