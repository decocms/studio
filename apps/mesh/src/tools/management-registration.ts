/**
 * Shared, ctx-free registration for the management MCP server's tools.
 *
 * The serving routes build a fresh `McpServer` per request, but the per-tool
 * registration (config + handler) is built once and shared across every
 * server. The handler reads its `StudioContext` from `managementContextStore`
 * at call time instead of capturing it, so a server that survives `close()`
 * (the production leak) no longer pins a request's ctx graph — the only heavy
 * per-request state a tool handler used to capture.
 *
 * A request must run inside `managementContextStore.run(ctx, ...)` for its tool
 * handlers to find their ctx.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolAnnotations } from "@/core/define-tool";
import type { StudioContext } from "@/core/studio-context";
import { z } from "zod";

export const managementContextStore = new AsyncLocalStorage<StudioContext>();

/** The slice of a tool the shared handler actually needs. */
export interface RegistrableTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  modelSummary?: (result: unknown) => string;
  execute: (input: unknown, ctx: StudioContext) => Promise<unknown>;
}

export function buildToolRegistration(tool: RegistrableTool) {
  const inputSchema =
    tool.inputSchema &&
    typeof tool.inputSchema === "object" &&
    "shape" in tool.inputSchema
      ? (tool.inputSchema as z.ZodObject<z.ZodRawShape>)
      : z.object({});
  const outputSchema =
    tool.outputSchema &&
    typeof tool.outputSchema === "object" &&
    "shape" in tool.outputSchema
      ? (tool.outputSchema as z.ZodObject<z.ZodRawShape>)
      : undefined;

  return {
    config: {
      description: tool.description ?? "",
      inputSchema,
      outputSchema,
      annotations: tool.annotations,
      _meta: tool._meta,
    },
    handler: async (args: unknown) => {
      const ctx = managementContextStore.getStore();
      if (!ctx) {
        throw new Error(
          `[managementMCP] tool ${tool.name} invoked outside a request context`,
        );
      }
      ctx.access.setToolName(tool.name);
      try {
        const result = await tool.execute(args, ctx);
        const modelText = tool.modelSummary
          ? tool.modelSummary(result)
          : JSON.stringify(result);
        return {
          content: [{ type: "text" as const, text: modelText }],
          structuredContent: result as { [x: string]: unknown },
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Per-process cache of tool registrations keyed by the static tool object.
 * Built lazily, reused for the life of the process, so the static tool set is
 * never re-derived per request — only the tiny `registerTool` map insertion
 * happens on each server build.
 */
const toolRegistrationCache = new Map<
  RegistrableTool,
  ReturnType<typeof buildToolRegistration>
>();

export function getToolRegistration(tool: RegistrableTool) {
  let registration = toolRegistrationCache.get(tool);
  if (!registration) {
    registration = buildToolRegistration(tool);
    toolRegistrationCache.set(tool, registration);
  }
  return registration;
}
