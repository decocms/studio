/**
 * Task-run MCP server — `POST /api/:org/mcp/task-run/:threadId`.
 *
 * The Studio surface a sandbox-hosted task run gets: the task-board tools it
 * needs to report on the task it is doing, plus `TASK_ADD_REPO`. It used to be
 * pointed at `/mcp/self`, i.e. every management tool Studio has.
 *
 * The run is identified by the PATH, not by a tool argument: the per-run API key
 * is minted with full access, so a `threadId` input would let one run act on
 * another run's sandbox. The org is already resolved (and membership checked) by
 * `resolveOrgFromPath`, so a foreign thread id here is out-of-org and its tools
 * find nothing.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { StudioContext } from "../../core/studio-context";
import { managementContextStore, toolSubsetMCP } from "../../tools";
import {
  resolveReviewRunToolNames,
  taskRunContextStore,
} from "../../tools/task-board/task-run-context";
import { serveMcpRequest } from "../utils/serve-mcp";

type TaskRunEnv = { Variables: { studioContext: StudioContext } };

export const createTaskRunMcpRoutes = () => {
  const app = new Hono<TaskRunEnv>();

  app.all("/:threadId", async (c) => {
    const ctx = c.get("studioContext");
    const threadId = c.req.param("threadId");
    // A reviewer's run gets one extra tool (`TASK_BOARD_REVIEW_DECISION`) — the
    // one it is instructed to finish with. Derived from the run thread itself,
    // not from a request argument, for the same reason the threadId is in the
    // path: the per-run key is minted with full access, so anything the caller
    // could assert it could also forge. The lookup is org-scoped by
    // `resolveOrgFromPath`, so a foreign thread reads as null → narrow list.
    const thread = await ctx.storage.threads.get(threadId);
    const server = toolSubsetMCP(
      "mcp-task-run",
      resolveReviewRunToolNames(thread?.title),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        c.req.raw.headers.get("Accept")?.includes("application/json") ?? false,
    });
    await server.connect(transport);
    // Tool handlers read both stores at call time, so the request must run
    // inside their scope.
    return managementContextStore.run(ctx, () =>
      taskRunContextStore.run({ threadId }, () =>
        serveMcpRequest(server, transport, c.req.raw, "mcp:task-run"),
      ),
    );
  });

  return app;
};
