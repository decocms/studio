/**
 * REST tool-dispatch endpoints.
 *
 * The web client invokes builtin/management tools over plain REST here instead
 * of MCP. The tool name in the path is the permission identifier — the same one
 * the MCP `/mcp/self` path used — enforced by the tool handler's own
 * `ctx.access.check()`. Auth + org membership are already established by the
 * global context factory and `resolveOrgFromPath`, so no MCP-specific auth is
 * needed.
 *
 *   POST /api/:org/tools/:toolName   call a tool (body = arguments)
 *   GET  /api/:org/tools             list the tools visible to this org
 */
import { Hono } from "hono";
import { z } from "zod";
import { ForbiddenError, UnauthorizedError } from "../../core/access-control";
import { TOOL_BY_NAME } from "../../tools";
import { getToolRegistration } from "../../tools/management-registration";
import type { Env } from "../hono-env";

const toJsonSchema = (schema: unknown): unknown => {
  if (!schema || typeof schema !== "object") return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodType);
  } catch {
    return undefined;
  }
};

export const createToolsRestRoutes = () => {
  const app = new Hono<Env>();

  // GET /api/:org/tools — MCP `listTools` parity (tool metadata, not a call).
  app.get("/", (c) => {
    const list = [...TOOL_BY_NAME.values()].map((tool) => {
      const { config } = getToolRegistration(tool);
      return {
        name: tool.name,
        description: config.description,
        inputSchema: toJsonSchema(config.inputSchema),
        outputSchema: toJsonSchema(config.outputSchema),
        annotations: config.annotations,
        _meta: config._meta,
      };
    });
    return c.json({ tools: list });
  });

  // POST /api/:org/tools/:toolName — call a builtin tool.
  app.post("/:toolName", async (c) => {
    const ctx = c.get("studioContext");
    const toolName = c.req.param("toolName");

    // Manual tool-identifier check: 404 if the name isn't part of the builtin
    // tool surface.
    const tool = TOOL_BY_NAME.get(toolName);
    if (!tool) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }

    // Body is the tool arguments (may be empty for no-arg tools).
    let rawInput: unknown;
    try {
      const text = await c.req.text();
      rawInput = text ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    // No MCP layer to validate input — validate against the tool's schema here.
    const parsed = (tool.inputSchema as z.ZodType).safeParse(rawInput);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid input", issues: parsed.error.issues },
        400,
      );
    }

    try {
      // `execute` sets the tool name on ctx.access and runs the handler, whose
      // own `ctx.access.check()` enforces the permission for this tool name.
      const result = await tool.execute(parsed.data, ctx);
      return c.json((result ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: error.message }, 401);
      }
      if (error instanceof ForbiddenError) {
        return c.json({ error: error.message }, 403);
      }
      const message = error instanceof Error ? error.message : "Tool failed";
      return c.json({ error: message }, 500);
    }
  });

  return app;
};
