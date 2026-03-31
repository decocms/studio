import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryMonitorResultListInputSchema,
  RegistryMonitorResultListOutputSchema,
} from "./monitor-schemas";

export const REGISTRY_MONITOR_RESULT_LIST = defineTool({
  name: "REGISTRY_MONITOR_RESULT_LIST" as const,
  description: "List results for a given MCP registry monitor run",
  inputSchema: RegistryMonitorResultListInputSchema,
  outputSchema: RegistryMonitorResultListOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    return storage.monitorResults.listByRun(organization.id, input.runId, {
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
  },
});
