import { useProjectContext } from "@/sdk";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "../lib/query-keys";

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
  const studio = useStudioTools();

  const { data } = useSuspenseQuery({
    queryKey: KEYS.secrets(org.id),
    staleTime: 60_000,
    queryFn: async () => {
      return await studio.call("SECRET_LIST", {});
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
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSecretInput) => {
      return await studio.call("SECRET_CREATE", { ...input });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.secrets(org.id) });
    },
  });
}
