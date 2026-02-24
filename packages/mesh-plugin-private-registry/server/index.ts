import type { ServerPlugin } from "@decocms/bindings/server-plugin";
import { PLUGIN_DESCRIPTION, PLUGIN_ID } from "../shared";
import { migrations } from "./migrations";
import { publicMCPServerRoutes, publicPublishRequestRoutes } from "./routes";
import { createStorage } from "./storage";
import { tools } from "./tools";
import { parseMonitorConfig } from "./tools/monitor-schemas";

export const serverPlugin: ServerPlugin = {
  id: PLUGIN_ID,
  description: PLUGIN_DESCRIPTION,
  tools,
  migrations,
  publicRoutes: (app, ctx) => {
    // Register specific routes BEFORE the wildcard MCP catch-all
    publicPublishRequestRoutes(app, ctx);
    publicMCPServerRoutes(app, ctx);
  },
  createStorage,
  onEvents: {
    types: ["registry.monitor.scheduled"],
    handler: async (events, ctx) => {
      const proxy = await ctx.createMCPProxy(ctx.connectionId);
      try {
        for (const event of events) {
          if (event.type !== "registry.monitor.scheduled") continue;
          const eventData =
            event.data && typeof event.data === "object"
              ? (event.data as Record<string, unknown>)
              : {};
          const rawConfig =
            eventData.config && typeof eventData.config === "object"
              ? eventData.config
              : {};
          const config = parseMonitorConfig(rawConfig);
          await proxy.callTool({
            name: "REGISTRY_MONITOR_RUN_START",
            arguments: { config },
          });
        }
      } finally {
        await proxy.close();
      }
    },
  },
};
