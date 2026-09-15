import type { QueryClient } from "@tanstack/react-query";
import { KEYS } from "./query-keys";

/**
 * Publish a Commerce Discovery ownership change to every report reader in this
 * browser. Cancel/remove first so an in-flight response cannot be cached under
 * the previous owner, then refresh the connection metadata that gates access.
 */
export async function refreshCommerceDiagnosticOwnership(
  queryClient: QueryClient,
  organizationId: string,
  connectionId: string,
): Promise<void> {
  const diagnosticPrefix = KEYS.commerceDiscoveryDiagnosticPrefix(
    organizationId,
    connectionId,
  );
  await queryClient.cancelQueries({ queryKey: diagnosticPrefix });
  queryClient.removeQueries({ queryKey: diagnosticPrefix });
  await queryClient.invalidateQueries({
    queryKey: KEYS.commerceDiscoveryConnection(organizationId, connectionId),
  });
}
