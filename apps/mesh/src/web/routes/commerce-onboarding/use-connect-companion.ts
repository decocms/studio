import { authenticateAndPersistOAuth } from "@/web/lib/authenticate-and-persist-oauth";
import { KEYS } from "@/web/lib/query-keys";
import type { RegistryItem } from "@/web/components/store/types";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  mergeBindingValue,
  unwrapToolResult,
  type CompanionCardModel,
} from "./companions-core.ts";

interface CompanionOrg {
  id: string;
  slug: string;
}

export function useConnectCompanion({
  selfClient,
  org,
  userId,
  cdConnectionId,
}: {
  selfClient: Client;
  org: CompanionOrg;
  userId: string;
  cdConnectionId: string;
}) {
  const queryClient = useQueryClient();
  const [connectingFieldKey, setConnectingFieldKey] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const updateConnection = async (
    id: string,
    data: Record<string, unknown>,
  ) => {
    const result = await selfClient.callTool({
      name: "COLLECTION_CONNECTIONS_UPDATE",
      arguments: { id, data },
    });
    return unwrapToolResult<{ item: unknown }>(result);
  };

  async function connect(card: CompanionCardModel): Promise<void> {
    setConnectingFieldKey(card.fieldKey);
    setError(null);
    try {
      // Step 0: reuse an existing candidate, else install a new connection.
      let companionId = card.candidateConnectionId;
      if (!companionId) {
        const data = extractConnectionData(
          card.registryItem as unknown as RegistryItem,
          org.id,
          userId,
          { remoteIndex: 0 },
        );
        const created = await selfClient.callTool({
          name: "COLLECTION_CONNECTIONS_CREATE",
          arguments: { data },
        });
        companionId = unwrapToolResult<{ item: { id: string } }>(created).item
          .id;
      }
      const id = companionId;

      // Step 1: OAuth only if needed (reuse target may already be authed).
      const auth = await authenticateAndPersistOAuth({
        connectionId: id,
        orgId: org.id,
        orgSlug: org.slug,
        persistFallback: (token) =>
          updateConnection(id, { connection_token: token }).then(
            () => undefined,
          ),
      });
      if (!auth.ok) {
        setError(`Couldn't sign in to ${card.title}: ${auth.error}`);
        return; // keep connection, no CD write
      }

      // Step 2: link — full read-modify-write of CD configuration_state.
      const cdGet = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: cdConnectionId },
      });
      const currentState =
        unwrapToolResult<{
          item: { configuration_state?: Record<string, unknown> | null } | null;
        }>(cdGet).item?.configuration_state ?? null;
      const merged = mergeBindingValue(
        currentState,
        card.fieldKey,
        card.bindingType,
        id,
      );
      await updateConnection(cdConnectionId, { configuration_state: merged });

      // Step 3: refresh (flip to Connected).
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
      });
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnections(org.id),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectingFieldKey(null);
    }
  }

  return { connect, connectingFieldKey, error };
}
