/**
 * Click-triggered "connect this app" flow: fetch the registry app by id,
 * reuse an existing connection for it (or create one), and run OAuth — no
 * dialog. Generalized from use-auto-install-github.ts (which auto-fires); this
 * one exposes a `connect()` you call on a button press.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useMCPClient,
  useProjectContext,
  type ConnectionEntity,
} from "@/sdk";
import { authenticateAndPersistOAuth } from "@/lib/authenticate-and-persist-oauth";
import { authClient } from "@/lib/auth-client";
import { useRegistryApp } from "@/hooks/use-registry-app";
import { extractConnectionData } from "@/utils/extract-connection-data";
import { invalidateVirtualMcpQueries } from "@/lib/query-keys";

export function useConnectApp(appId: string) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [isConnecting, setIsConnecting] = useState(false);

  // Deferred — the tile shouldn't hit the registry on every home render. The
  // registry GET is kicked off on click via refetch() (which ignores `enabled`).
  const registry = useRegistryApp(appId, { enabled: false });

  const connect = async () => {
    if (isConnecting || !session?.user?.id || !org) return;
    setIsConnecting(true);
    try {
      const item = registry.data ?? (await registry.refetch()).data;
      if (!item) {
        toast.error("Could not find this integration in the registry");
        return;
      }

      const connectionData = extractConnectionData(
        item,
        org.id,
        session.user.id,
        {
          remoteIndex: 0,
        },
      );
      if (!connectionData.connection_url) {
        toast.error("This integration has no connection method available");
        return;
      }

      // Reuse an existing connection for this app instead of creating a
      // duplicate every click. app_name is the canonical per-app identifier.
      const existing = connectionData.app_name
        ? await findConnectionByAppName(client, connectionData.app_name)
        : null;

      const created = !existing;
      const id =
        existing?.id ?? (await actions.create.mutateAsync(connectionData)).id;

      const auth = await authenticateAndPersistOAuth({
        connectionId: id,
        orgId: org.id,
        orgSlug: org.slug,
        persistFallback: (token) =>
          actions.update
            .mutateAsync({ id, data: { connection_token: token } })
            .then(() => undefined),
      });

      if (auth.ran && !auth.ok) {
        // Only roll back what we created — never delete a pre-existing one.
        if (created) {
          try {
            await actions.delete.mutateAsync(id);
          } catch {
            // best-effort cleanup
          }
        }
        toast.error(`Authentication failed: ${auth.error ?? "no token"}`);
        return;
      }

      invalidateVirtualMcpQueries(queryClient, org.id);
      toast.success(created ? "Connected successfully" : "Already connected");
    } catch (error) {
      toast.error(
        `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsConnecting(false);
    }
  };

  return { connect, isConnecting };
}

async function findConnectionByAppName(
  client: ReturnType<typeof useMCPClient>,
  appName: string,
): Promise<ConnectionEntity | null> {
  const res = await client.callTool({
    name: "COLLECTION_CONNECTIONS_LIST",
    arguments: {
      where: { field: ["app_name"], operator: "eq", value: appName },
      limit: 1,
    },
  });
  const items = (res.structuredContent as { items?: ConnectionEntity[] })
    ?.items;
  return items?.[0] ?? null;
}
