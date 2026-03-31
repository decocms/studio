import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryMonitorConnectionUpdateAuthInputSchema,
  RegistryMonitorConnectionUpdateAuthOutputSchema,
} from "./monitor-schemas";

export const REGISTRY_MONITOR_CONNECTION_UPDATE_AUTH = defineTool({
  name: "REGISTRY_MONITOR_CONNECTION_UPDATE_AUTH" as const,
  description:
    "Update the auth_status of a monitor connection mapping (by core connection ID)",
  inputSchema: RegistryMonitorConnectionUpdateAuthInputSchema,
  outputSchema: RegistryMonitorConnectionUpdateAuthOutputSchema,
  handler: async ({ connectionId, authStatus }, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const orgId = organization.id;
    const mapping = await storage.monitorConnections.findByConnectionId(
      orgId,
      connectionId,
    );
    if (!mapping) {
      throw new Error(
        `No monitor connection mapping found for connection ${connectionId}`,
      );
    }

    await storage.monitorConnections.updateAuthStatus(
      orgId,
      mapping.item_id,
      authStatus,
    );

    return { success: true };
  },
});
