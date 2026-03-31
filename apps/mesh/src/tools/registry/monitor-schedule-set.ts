import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import {
  RegistryMonitorScheduleSetInputSchema,
  RegistryMonitorScheduleSetOutputSchema,
} from "./monitor-schemas";

function findEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const direct = record.id;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  for (const key of ["event", "result", "structuredContent", "content"]) {
    const nested = record[key];
    const id = findEventId(nested);
    if (id) return id;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const id = findEventId(item);
      if (id) return id;
    }
  }
  return null;
}

export const REGISTRY_MONITOR_SCHEDULE_SET = defineTool({
  name: "REGISTRY_MONITOR_SCHEDULE_SET" as const,
  description: "Schedule recurring MCP monitor runs via EVENT_PUBLISH cron",
  inputSchema: RegistryMonitorScheduleSetInputSchema,
  outputSchema: RegistryMonitorScheduleSetOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const selfConnectionId = WellKnownOrgMCPId.SELF(organization.id);
    const proxy = await ctx.createMCPProxy(selfConnectionId);
    try {
      const result = await proxy.callTool({
        name: "EVENT_PUBLISH",
        arguments: {
          type: "registry.monitor.scheduled",
          subject: "private-registry",
          cron: input.cronExpression,
          data: {
            config: input.config ?? {},
          },
        },
      });
      if (result.isError) {
        throw new Error("Failed to create monitor schedule via EVENT_PUBLISH");
      }
      const scheduleEventId =
        findEventId(result.structuredContent) ??
        findEventId(result.content) ??
        findEventId(result);
      if (!scheduleEventId) {
        throw new Error(
          "Could not resolve schedule event id from EVENT_PUBLISH",
        );
      }
      return { scheduleEventId };
    } finally {
      await proxy.close?.().catch(() => {});
    }
  },
});
