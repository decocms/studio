import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import type { z } from "zod";
import {
  RegistryMonitorRunCancelInputSchema,
  RegistryMonitorRunCancelOutputSchema,
} from "./monitor-schemas";
import { cancelMonitorRun } from "./monitor-run-start";

export const REGISTRY_MONITOR_RUN_CANCEL = defineTool({
  name: "REGISTRY_MONITOR_RUN_CANCEL" as const,
  description: "Cancel a running MCP registry monitor run",
  inputSchema: RegistryMonitorRunCancelInputSchema,
  outputSchema: RegistryMonitorRunCancelOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    cancelMonitorRun(input.runId);
    const storage = ctx.storage.registry;
    const run = await storage.monitorRuns.update(organization.id, input.runId, {
      status: "cancelled",
      current_item_id: null,
      finished_at: new Date().toISOString(),
    });
    return { run } as z.infer<typeof RegistryMonitorRunCancelOutputSchema>;
  },
});
