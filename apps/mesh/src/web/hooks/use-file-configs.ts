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

export interface FileConfigInfo {
  id: string;
  name: string;
  description: string | null;
  bucket: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  prefix: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export function useFileConfigs() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.fileConfigs(org.id),
    staleTime: 60_000,
    queryFn: async () => {
      const result = await client.callTool({
        name: "FILE_CONFIG_LIST",
        arguments: {},
      });
      return unwrapToolResult<{ configs: FileConfigInfo[] }>(result);
    },
  });

  return data.configs;
}

export interface CreateFileConfigInput {
  name: string;
  description?: string;
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function useCreateFileConfig() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateFileConfigInput) => {
      const result = await client.callTool({
        name: "FILE_CONFIG_CREATE",
        arguments: { ...input },
      });
      return unwrapToolResult<FileConfigInfo>(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.fileConfigs(org.id) });
    },
  });
}

export interface UpdateFileConfigInput {
  id: string;
  name?: string;
  description?: string | null;
  bucket?: string;
  region?: string;
  endpoint?: string | null;
  forcePathStyle?: boolean;
  prefix?: string | null;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function useUpdateFileConfig() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateFileConfigInput) => {
      const result = await client.callTool({
        name: "FILE_CONFIG_UPDATE",
        arguments: { ...input },
      });
      return unwrapToolResult<FileConfigInfo>(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.fileConfigs(org.id) });
    },
  });
}

export function useDeleteFileConfig() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const result = await client.callTool({
        name: "FILE_CONFIG_DELETE",
        arguments: { id },
      });
      return unwrapToolResult<{ success: true }>(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.fileConfigs(org.id) });
    },
  });
}
