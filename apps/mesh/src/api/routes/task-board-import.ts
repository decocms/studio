import { Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { requireTaskBoardEnabled } from "@/tools/task-board/require-enabled";
import { TaskBoardItemPrioritySchema } from "@/tools/task-board/schema";
import { bearerToken, isVaultServiceToken } from "./credential-vault";

/**
 * Internal task-board import — a trusted machine service (commerce-discovery's
 * diagnostic worker) batch-creates task board items for the org at the end of
 * an enriched report run.
 *
 *   POST /api/:org/internal/task-board/import
 *
 * Auth mirrors the credential vault's service lease: the shared
 * VAULT_SERVICE_TOKEN bearer alone authenticates (constant-time compare), and
 * the org resolved from the path is the only bound. Like the vault path, the
 * caller holds the org *id*, so resolve-org-from-path also matches this route
 * in its resolve-by-id allowlist.
 *
 * The endpoint enforces the org's `task_board_enabled` setting before writing
 * (403 `task_board_disabled` — an expected, fail-soft skip for the caller).
 * Items land as status "triage" with `created_by = "system"` (the established
 * sentinel for non-user principals). `source` is accepted for observability /
 * future dedup and not persisted yet.
 */

type Variables = {
  studioContext: StudioContext;
};

export const importBodySchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(4000).nullable().optional(),
        priority: TaskBoardItemPrioritySchema.optional(),
      }),
    )
    .min(1)
    .max(100),
  source: z
    .object({
      url: z.string().max(500),
      run_id: z.string().max(200).optional(),
    })
    .optional(),
});

export const createTaskBoardImportRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/internal/task-board/import", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isVaultServiceToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    try {
      await requireTaskBoardEnabled(ctx, organizationId);
    } catch {
      return c.json({ error: "task_board_disabled" }, 403);
    }

    const parsed = importBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400,
      );
    }

    let created = 0;
    for (const item of parsed.data.items) {
      await ctx.storage.taskBoard.create({
        organizationId,
        title: item.title,
        description: item.description ?? null,
        priority: item.priority,
        by: "system",
      });
      created++;
    }

    return c.json({ created });
  });

  return app;
};
