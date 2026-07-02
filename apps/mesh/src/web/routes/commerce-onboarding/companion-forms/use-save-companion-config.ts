import { KEYS } from "@/web/lib/query-keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CompanionCardModel } from "../companions-core.ts";

export function useSaveCompanionConfig({
  card,
  selfClient,
  org,
  onDone,
}: {
  card: CompanionCardModel;
  selfClient: Client;
  org: { id: string };
  onDone: () => void;
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
          patch: {
            configuration_state: mergedState,
          },
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnections(org.id),
      });
      onDone();
    },
  });

  const save = (values: Record<string, unknown>) => mutation.mutate(values);

  return { save, isPending: mutation.isPending, error: mutation.error };
}
