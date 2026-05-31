import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectionActions, useProjectContext } from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import { authClient } from "@/web/lib/auth-client";
import { connectApp } from "@/web/lib/connect-app";
import { KEYS } from "@/web/lib/query-keys";

export type ConnectAppStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "ready"
  | "error";

/**
 * Drives inline connect for a single ConnectCard slot row. `connect(item)` runs
 * the shared `connectApp` pipeline and exposes a per-row status/error. On
 * success it invalidates `connectionResolveForUser` queries so any mounted
 * ConnectCard slot rows that resolved the same app reflect the new connection
 * state. The user then manually clicks Retry to re-run the last turn.
 */
export function useConnectApp(): {
  connect: (item: RegistryItem) => Promise<void>;
  status: ConnectAppStatus;
  error: string | null;
} {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectAppStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = async (item: RegistryItem) => {
    if (!session?.user?.id) {
      // The connect button is only rendered for authenticated users, so this
      // is a defensive guard that should not fire in practice.
      console.warn("useConnectApp: no session user, skipping connect");
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const result = await connectApp(item, {
        org: { id: org.id, slug: org.slug },
        userId: session.user.id,
        connectionActions,
        queryClient,
        onPhase: (phase) => setStatus(phase),
      });
      if (result.error) {
        setStatus("error");
        setError(
          result.error === "no-connection-method"
            ? "This app can't be connected automatically."
            : "Couldn't connect. Try again.",
        );
        return;
      }
      // Re-resolve slot rows for this app so they reflect the new connection.
      await queryClient.invalidateQueries({
        queryKey: KEYS.connectionResolveForUserPrefix(),
      });
      setStatus("ready");
    } catch (err) {
      console.error("Inline connect failed:", err);
      setStatus("error");
      setError("Couldn't connect. Try again.");
    }
  };

  return { connect, status, error };
}
