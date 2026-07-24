import { KEYS } from "@/lib/query-keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CompanionCardModel } from "../companions-core.ts";

export function useSaveCompanionConfig({
  card,
  selfClient,
  org,
  onDone,
  onError,
}: {
  card: CompanionCardModel;
  selfClient: Client;
  org: { id: string };
  onDone: () => void;
  onError?: (error: Error) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (formValues: Record<string, unknown>) => {
      const mergedState = {
        ...(card.configurationState ?? {}),
        ...formValues,
      };
      await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_UPDATE",
        arguments: {
          id: card.linkedConnectionId || card.candidateConnectionId,
          data: {
            configuration_state: mergedState,
          },
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnectionsPrefix(org.id),
      });
      onDone();
    },
    onError: (error: Error) => {
      onError?.(error);
    },
  });

  const save = (values: Record<string, unknown>) => mutation.mutate(values);

  return { save, isPending: mutation.isPending, error: mutation.error };
}
