/**
 * Thread MCP server — `POST /api/:org/mcp/thread/:threadId`.
 *
 * The Studio surface a sandbox-hosted run gets (mounted as `studio` in Claude
 * Code): the tools Decopilot chats had as built-ins, the task-board tools a run
 * reports through, and `TASK_ADD_REPO`. Which set is derived from the thread
 * (`resolveThreadToolNames`).
 *
 * The run is identified by the PATH, not by a tool argument: a `threadId`
 * input would let one run act on another run's sandbox with the same key. The
 * org is already resolved (and membership checked) by `resolveOrgFromPath`, so
 * a foreign thread id here is out-of-org and its tools find nothing.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "../../core/studio-context";
import { managementContextStore, toolSubsetMCP } from "../../tools";
import {
  resolveThreadToolNames,
  taskRunContextStore,
} from "../../tools/task-board/task-run-context";
import { serveMcpRequest } from "../utils/serve-mcp";

type ThreadMcpEnv = { Variables: { studioContext: StudioContext } };

/** `task-run` is the pre-rename path; keys minted before the rename still point at it. */
export const THREAD_MCP_PATHS = ["/mcp/thread", "/mcp/task-run"] as const;

const ProgressRequestSchema = z.object({
  params: z.object({
    _meta: z.object({ progressToken: z.union([z.string(), z.number()]) }),
  }),
});

/**
 * A JSON response carries no notifications, so a call that asked for progress
 * (Claude Code always does) is answered over SSE — otherwise a long tool goes
 * silent and trips the client's idle timeout.
 */
async function requestsProgress(req: Request): Promise<boolean> {
  const body: unknown = await req
    .clone()
    .json()
    .catch(() => null);
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) => ProgressRequestSchema.safeParse(message).success,
  );
}

export const createThreadMcpRoutes = () => {
  const app = new Hono<ThreadMcpEnv>();

  app.all("/:threadId", async (c) => {
    const ctx = c.get("studioContext");
    const threadId = c.req.param("threadId");
    // From the thread, not an argument the caller could forge with the same key.
    const thread = await ctx.storage.threads.get(threadId);
    const server = toolSubsetMCP("mcp-thread", resolveThreadToolNames(thread));
    const acceptsJson =
      c.req.raw.headers.get("Accept")?.includes("application/json") ?? false;
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        acceptsJson &&
        !(c.req.method === "POST" && (await requestsProgress(c.req.raw))),
    });
    await server.connect(transport);
    // Tool handlers read both stores at call time, so the request must run
    // inside their scope.
    return managementContextStore.run(ctx, () =>
      taskRunContextStore.run({ threadId }, () =>
        serveMcpRequest(server, transport, c.req.raw, "mcp:thread"),
      ),
    );
  });

  return app;
};
