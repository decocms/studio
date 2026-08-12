import { authenticateAndPersistOAuth } from "@/lib/authenticate-and-persist-oauth";
import { track } from "@/lib/posthog-client";
import { reportAttributionFromSearch } from "@/routes/reports/track";
import { KEYS } from "@/lib/query-keys";
import type { RegistryItem } from "@/components/store/types";
import { extractConnectionData } from "@/utils/extract-connection-data";
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
  domain,
  siteUrl,
}: {
  selfClient: Client;
  org: CompanionOrg;
  userId: string;
  cdConnectionId: string;
  domain?: string;
  siteUrl?: string;
}) {
  const queryClient = useQueryClient();
  const [connectingFieldKey, setConnectingFieldKey] = useState<string | null>(
    null,
  );
  const [disconnectingFieldKey, setDisconnectingFieldKey] = useState<
    string | null
  >(null);
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

  async function connect(card: CompanionCardModel): Promise<boolean> {
    setConnectingFieldKey(card.fieldKey);
    setError(null);
    // Per-card connect rates were invisible: the only signal was the generic
    // server-side connection_created, which carries no onboarding context.
    const basePayload = {
      app_name: card.title,
      field_key: card.fieldKey,
      organization_id: org.id,
      domain,
      site_url: siteUrl,
      ...reportAttributionFromSearch(window.location.search),
    };
    track("commerce_onboarding_companion_connect_clicked", basePayload);
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

        // Validate connection data based on type (same guard as
        // use-install-from-registry.ts / add-connection-dialog.tsx /
        // connections.tsx) — an installable-looking registry item can still
        // lack a usable remote URL or STDIO command.
        const isStdioConnection = data.connection_type === "STDIO";
        const hasUrl = Boolean(data.connection_url);
        const hasStdioConfig =
          isStdioConnection &&
          data.connection_headers &&
          typeof data.connection_headers === "object" &&
          "command" in data.connection_headers;

        if (!hasUrl && !hasStdioConfig) {
          track("commerce_onboarding_companion_connect_failed", {
            ...basePayload,
            error: "no_connection_method",
          });
          setError(
            `${card.title} cannot be connected: no connection method available`,
          );
          return false;
        }

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
        track("commerce_onboarding_companion_connect_failed", {
          ...basePayload,
          error: auth.error,
        });
        setError(`Couldn't sign in to ${card.title}: ${auth.error}`);
        return false; // keep connection, no CD write
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
      // GitHub carries a free-standing github_repo string on the CD state that is
      // NOT tied to this connection id (unlike the binding value). A stale repo
      // left over from a previous store would silently leak into the next run's
      // report, so (re)connecting GitHub resets it — the user re-picks the repo in
      // the config form against the just-connected account.
      if (card.bindingType === "github") {
        delete merged.github_repo;
      }
      await updateConnection(cdConnectionId, { configuration_state: merged });

      // Step 3: refresh (flip to Connected).
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
      });
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnectionsPrefix(org.id),
      });
      track("commerce_onboarding_companion_connected", basePayload);
      return true;
    } catch (err) {
      track("commerce_onboarding_companion_connect_failed", {
        ...basePayload,
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setConnectingFieldKey(null);
    }
  }

  // Unlink a companion so the user can revalidate: drop its binding from the CD
  // configuration_state (read-modify-write), which reverts the card to
  // "Conectar". We intentionally DON'T delete the underlying connection — a
  // subsequent connect re-links a fresh/org-level one (repo-scoped children are
  // excluded from candidates) and re-runs OAuth. GitHub's free-standing
  // github_repo is cleared too, so the repo is re-picked against the next link.
  async function disconnect(card: CompanionCardModel): Promise<boolean> {
    setDisconnectingFieldKey(card.fieldKey);
    setError(null);
    const basePayload = {
      app_name: card.title,
      field_key: card.fieldKey,
      organization_id: org.id,
      domain,
      site_url: siteUrl,
      ...reportAttributionFromSearch(window.location.search),
    };
    track("commerce_onboarding_companion_disconnect_clicked", basePayload);
    try {
      const cdGet = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: cdConnectionId },
      });
      const currentState =
        unwrapToolResult<{
          item: { configuration_state?: Record<string, unknown> | null } | null;
        }>(cdGet).item?.configuration_state ?? null;
      const next = { ...(currentState ?? {}) };
      delete next[card.fieldKey];
      if (card.bindingType === "github") {
        delete next.github_repo;
      }
      await updateConnection(cdConnectionId, { configuration_state: next });
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
      });
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnectionsPrefix(org.id),
      });
      track("commerce_onboarding_companion_disconnected", basePayload);
      return true;
    } catch (err) {
      track("commerce_onboarding_companion_disconnect_failed", {
        ...basePayload,
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setDisconnectingFieldKey(null);
    }
  }

  return {
    connect,
    connectingFieldKey,
    disconnect,
    disconnectingFieldKey,
    error,
  };
}
