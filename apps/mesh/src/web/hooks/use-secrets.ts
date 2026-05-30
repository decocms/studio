import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { unwrapToolResult } from "../lib/unwrap-tool-result";

export type SecretScopeKind = "user" | "organization";

export interface SecretInfo {
  id: string;
  scope: SecretScopeKind;
  userId: string | null;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export function useSecrets() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.secrets(org.id),
    staleTime: 60_000,
    queryFn: async () => {
      const result = await client.callTool({
        name: "SECRET_LIST",
        arguments: {},
      });
      return unwrapToolResult<{ secrets: SecretInfo[] }>(result);
    },
  });

  return data.secrets;
}

export interface CreateSecretInput {
  scope: SecretScopeKind;
  name: string;
  value: string;
  description?: string;
}

export function useCreateSecret() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSecretInput) => {
      const result = await client.callTool({
        name: "SECRET_CREATE",
        arguments: { ...input },
      });
      return unwrapToolResult<SecretInfo>(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.secrets(org.id) });
    },
  });
}
