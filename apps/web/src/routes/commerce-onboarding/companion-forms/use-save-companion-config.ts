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
    mutationFn: async ({
      values,
      connectionToken,
    }: {
      values: Record<string, unknown>;
      connectionToken?: string;
    }) => {
      const mergedState = {
        ...(card.configurationState ?? {}),
        ...values,
      };
      const data: Record<string, unknown> = {
        configuration_state: mergedState,
      };
      // undefined ⇒ keep the stored connection_token.
      if (connectionToken !== undefined) {
        data.connection_token = connectionToken;
      }
      await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_UPDATE",
        arguments: {
          id: card.linkedConnectionId || card.candidateConnectionId,
          data,
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

  const save = (
    values: Record<string, unknown>,
    opts?: { connectionToken?: string },
  ) => mutation.mutate({ values, connectionToken: opts?.connectionToken });

  return { save, isPending: mutation.isPending, error: mutation.error };
}
