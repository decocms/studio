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
 *
 * A caller whose key is bound to a thread (a sandbox run using the `decocms`
 * CLI) gets that thread's surface, as on the thread MCP (`thread-mcp.ts`).
 */
import { Hono } from "hono";
import { z } from "zod";
import { ForbiddenError, UnauthorizedError } from "../../core/access-control";
import { ConflictError } from "../../core/conflict-error";
import { GatewayRefusalError } from "../../ai-providers/adapters/deco-ai-gateway";
import { OrgBlockedError } from "../../core/org-notice-gate";
import { GitProviderError } from "../../git-providers/types";
import type { StudioContext } from "../../core/studio-context";
import {
  managementContextStore,
  resolveToolByName,
  TOOL_BY_NAME,
} from "../../tools";
import {
  getToolRegistration,
  type RegistrableTool,
} from "../../tools/management-registration";
import {
  resolveThreadToolNames,
  taskRunContextStore,
} from "../../tools/task-board/task-run-context";
import type { Env } from "../hono-env";

/** Wait reported when a rate-limited provider named none. */
const PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;

const toJsonSchema = (schema: unknown): unknown => {
  if (!schema || typeof schema !== "object") return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodType);
  } catch {
    return undefined;
  }
};

/**
 * The tools a thread-bound caller may list and call: the thread's surface,
 * from the key's own thread. Null for every other caller.
 */
async function threadSurface(
  ctx: StudioContext,
): Promise<{ threadId: string; tools: RegistrableTool[] } | null> {
  const threadId = ctx.auth.boundThreadId;
  if (!threadId) return null;
  const thread = await ctx.storage.threads.get(threadId);
  const tools = resolveThreadToolNames(thread)
    .map((name) => resolveToolByName(name))
    .filter((tool) => tool !== undefined);
  return { threadId, tools };
}

export const createToolsRestRoutes = () => {
  const app = new Hono<Env>();

  // GET /api/:org/tools — MCP `listTools` parity (tool metadata, not a call).
  app.get("/", async (c) => {
    const surface = await threadSurface(c.get("studioContext"));
    const tools = surface ? surface.tools : [...TOOL_BY_NAME.values()];
    const list = tools.map((tool) => {
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
    const tool = resolveToolByName(toolName);
    const surface = await threadSurface(ctx);
    if (!tool || (surface && !surface.tools.includes(tool))) {
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
      // A thread-bound call runs in the stores the thread MCP's handlers read.
      const result = surface
        ? await managementContextStore.run(ctx, () =>
            taskRunContextStore.run({ threadId: surface.threadId }, () =>
              tool.execute(parsed.data, ctx),
            ),
          )
        : await tool.execute(parsed.data, ctx);
      return c.json((result ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: error.message }, 401);
      }
      if (error instanceof ConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof OrgBlockedError) {
        return c.json({ error: error.message, code: error.code }, 403);
      }
      if (error instanceof ForbiddenError) {
        // Carry `code` when the refusal has one. `FeatureNotInPlanError` and
        // `AiBudgetExhaustedError` also extend ForbiddenError, so this branch
        // was stripping the very field the client reads to tell a PLAN refusal
        // from a permission error — which made the paywall, the "never retry a
        // plan refusal" rule and the whole notifyPlanRefusal path inert for
        // every gated tool. A plain ForbiddenError still has no code.
        const code = (error as { code?: unknown }).code;
        return c.json(
          typeof code === "string"
            ? { error: error.message, code }
            : { error: error.message },
          403,
        );
      }
      // A refusal the AI gateway named, not a mesh failure: keep its status
      // and its code so the client can say "plans are not enabled yet" instead
      // of showing an HTTP number inside a 500.
      if (error instanceof GatewayRefusalError) {
        return c.json(
          { error: error.message, ...(error.code ? { code: error.code } : {}) },
          error.status === 503 ? 503 : 403,
        );
      }
      // The provider's budget is spent, not broken: name the wait so the
      // client neither retries into it nor polls through it.
      if (error instanceof GitProviderError && error.isRateLimited) {
        const retryAfterMs =
          error.retryAfterMs ?? PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS;
        c.header(
          "Retry-After",
          String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        );
        return c.json(
          { error: error.message, code: "provider_rate_limited", retryAfterMs },
          429,
        );
      }
      const message = error instanceof Error ? error.message : "Tool failed";
      return c.json({ error: message }, 500);
    }
  });

  return app;
};
