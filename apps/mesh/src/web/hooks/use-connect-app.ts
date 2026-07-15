/**
 * Click-triggered "connect this app" flow: fetch the registry app by id,
 * create a connection, and run OAuth — no dialog. Generalized from
 * use-auto-install-github.ts (which auto-fires); this one exposes a `connect()`
 * you call on a button press.
 *
 * ponytail: no dedup — a repeat click on an already-connected app creates
 * another instance (same as the catalog "Connect" button). Add a slug lookup
 * if duplicates become a problem.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useConnectionActions, useProjectContext } from "@decocms/mesh-sdk";
import { authenticateAndPersistOAuth } from "@/web/lib/authenticate-and-persist-oauth";
import { authClient } from "@/web/lib/auth-client";
import { useRegistryApp } from "@/web/hooks/use-registry-app";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";

export function useConnectApp(appId: string) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();
  const queryClient = useQueryClient();
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

      const { id } = await actions.create.mutateAsync(connectionData);

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
        try {
          await actions.delete.mutateAsync(id);
        } catch {
          // best-effort cleanup
        }
        toast.error(`Authentication failed: ${auth.error ?? "no token"}`);
        return;
      }

      invalidateVirtualMcpQueries(queryClient, org.id);
      toast.success("Connected successfully");
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
