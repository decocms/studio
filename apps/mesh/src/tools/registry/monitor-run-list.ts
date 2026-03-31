import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import type { z } from "zod";
import {
  RegistryMonitorRunListInputSchema,
  RegistryMonitorRunListOutputSchema,
} from "./monitor-schemas";

export const REGISTRY_MONITOR_RUN_LIST = defineTool({
  name: "REGISTRY_MONITOR_RUN_LIST" as const,
  description: "List MCP registry monitor runs",
  inputSchema: RegistryMonitorRunListInputSchema,
  outputSchema: RegistryMonitorRunListOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    return storage.monitorRuns.list(organization.id, input) as Promise<
      z.infer<typeof RegistryMonitorRunListOutputSchema>
    >;
  },
});
