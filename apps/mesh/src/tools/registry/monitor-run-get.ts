import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import type { z } from "zod";
import {
  RegistryMonitorRunGetInputSchema,
  RegistryMonitorRunGetOutputSchema,
} from "./monitor-schemas";

export const REGISTRY_MONITOR_RUN_GET = defineTool({
  name: "REGISTRY_MONITOR_RUN_GET" as const,
  description: "Get details for one MCP registry monitor run",
  inputSchema: RegistryMonitorRunGetInputSchema,
  outputSchema: RegistryMonitorRunGetOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const run = await storage.monitorRuns.findById(
      organization.id,
      input.runId,
    );
    return { run } as z.infer<typeof RegistryMonitorRunGetOutputSchema>;
  },
});
