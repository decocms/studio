import { useProjectContext } from "@/sdk";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "../lib/query-keys";

export interface FileConfigInfo {
  id: string;
  name: string;
  description: string | null;
  bucket: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  prefix: string | null;
  publicUrlBase: string | null;
  credentialType: "static" | "sts-session" | "managed";
  refreshUrl: string | null;
  siteSlug: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export function useFileConfigs() {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data } = useSuspenseQuery({
    queryKey: KEYS.fileConfigs(org.id),
    staleTime: 60_000,
    queryFn: () => studio.call("FILE_CONFIG_LIST", {}),
  });

  return data.configs;
}

/**
 * Non-suspense variant: returns `undefined` while loading instead of
 * suspending the caller. Use this in field-level UI (ImageField,
 * FileField) that wants to make decisions based on the configs count
 * (1 config → drop-upload directly; 2+ → open the picker) without
 * blocking the form render. Shares the cache key with useFileConfigs.
 */
export function useFileConfigsQuery() {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.fileConfigs(org.id),
    staleTime: 60_000,
    queryFn: () => studio.call("FILE_CONFIG_LIST", {}),
  });
}

export interface CreateFileConfigInput {
  name: string;
  description?: string;
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  publicUrlBase?: string;
  // Defaults to "static" (long-lived key pair). "sts-session" instead stores a
  // refreshUrl + apiKey reference whose temporary credentials are fetched on
  // demand and auto-refreshed.
  credentialType?: "static" | "sts-session";
  // static
  accessKeyId?: string;
  secretAccessKey?: string;
  // sts-session
  refreshUrl?: string;
  apiKey?: string;
}

export function useCreateFileConfig() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateFileConfigInput) =>
      studio.call("FILE_CONFIG_CREATE", { ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.fileConfigs(org.id) });
    },
  });
}

export function useDeleteFileConfig() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => studio.call("FILE_CONFIG_DELETE", { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.fileConfigs(org.id) });
    },
  });
}
