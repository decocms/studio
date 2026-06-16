/**
 * Background-tool enqueue route (daemon → cluster).
 *
 *   POST /api/:org/threads/:threadId/background-tool
 *
 * A desktop-daemon run can't background a slow tool itself (no DBOS, ephemeral
 * process). Instead its `generate_image` posts here and the cluster runs the
 * durable `backgroundToolWorkflow` (generate → append → react). Auth mirrors
 * the link-ingest chunk route: the daemon presents the run's temp bearer (so
 * `resolveOrgFromPath` + principal resolve org/user) plus the run fence token,
 * which must match the active run — a stale/foreign run can't enqueue work.
 *
 * Identity (org, user) comes from the authenticated context, never the body;
 * the body only carries the tool payload + the thread/model snapshot the
 * reaction turn needs.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "@/api/hono-env";
import { fenceMatches } from "@/storage/run-fence";
import { isCancelRequested } from "@/storage/cancel-flag";
import { createBackgroundToolDispatcher } from "@/harnesses/decopilot/background-tool-workflow";

const BodySchema = z.object({
  toolName: z.literal("generate_image"),
  input: z.unknown(),
  toolCallId: z.string(),
  agentId: z.string(),
  temperature: z.number(),
  toolApprovalLevel: z.enum(["auto", "readonly"]),
  branch: z.string().nullable().optional(),
});

async function validateRunAccess(c: Context<Env>) {
  const ctx = c.get("meshContext");
  const userId = ctx.auth?.user?.id;
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const threadId = c.req.param("threadId");
  if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
    return c.json({ error: "invalid threadId" }, 400);
  }

  const thread = await ctx.storage.threads.get(threadId);
  if (!thread || thread.organization_id !== ctx.organization!.id) {
    return c.json({ error: "not found" }, 404);
  }

  const cancelAt = await ctx.storage.threads.getCancelRequestedAt(threadId);
  if (isCancelRequested(cancelAt)) {
    return c.json({ error: "cancelled" }, 409);
  }

  const current = await ctx.storage.threads.getRunFence(threadId);
  if (current === null) {
    return c.json({ error: "no active run fence" }, 409);
  }
  if (!fenceMatches(current, c.req.header("x-fence-token") ?? null)) {
    return c.json({ error: "fenced" }, 409);
  }

  return { ctx, threadId, userId };
}

export function createBackgroundToolRoutes() {
  const app = new Hono<Env>();

  app.post("/threads/:threadId/background-tool", async (c) => {
    const access = await validateRunAccess(c);
    if (access instanceof Response) return access;
    const { ctx, threadId, userId } = access;

    const parsed = BodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid body" }, 400);
    }
    const body = parsed.data;

    const dispatcher = createBackgroundToolDispatcher({
      threadId,
      orgId: ctx.organization!.id,
      userId,
      agentId: body.agentId,
      temperature: body.temperature,
      toolApprovalLevel: body.toolApprovalLevel,
      branch: body.branch ?? null,
    });
    const { jobId } = await dispatcher.start({
      toolName: body.toolName,
      input: body.input,
      toolCallId: body.toolCallId,
    });

    return c.json({ jobId });
  });

  return app;
}
