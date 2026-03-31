import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import {
  RegistryMonitorScheduleCancelInputSchema,
  RegistryMonitorScheduleCancelOutputSchema,
} from "./monitor-schemas";

export const REGISTRY_MONITOR_SCHEDULE_CANCEL = defineTool({
  name: "REGISTRY_MONITOR_SCHEDULE_CANCEL" as const,
  description: "Cancel a recurring MCP monitor schedule via EVENT_CANCEL",
  inputSchema: RegistryMonitorScheduleCancelInputSchema,
  outputSchema: RegistryMonitorScheduleCancelOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const selfConnectionId = WellKnownOrgMCPId.SELF(organization.id);
    const proxy = await ctx.createMCPProxy(selfConnectionId);
    try {
      const result = await proxy.callTool({
        name: "EVENT_CANCEL",
        arguments: { eventId: input.scheduleEventId },
      });
      if (result.isError) {
        throw new Error("Failed to cancel monitor schedule via EVENT_CANCEL");
      }
      return { success: true };
    } finally {
      await proxy.close?.().catch(() => {});
    }
  },
});
