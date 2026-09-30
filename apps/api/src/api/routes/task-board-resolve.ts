import { Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { captureOrgEvent } from "@/posthog";
import type { FindingResolution } from "@/storage/task-board";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import { bearerToken, isVaultServiceToken } from "./credential-vault";

/**
 * Internal task-board resolve. The reports engine tells Studio that the Deco
 * Score check behind some cards passes now, so the board stops showing work
 * that no longer needs doing.
 *
 *   POST /api/:org/internal/task-board/resolve
 *   { items: [{ id }], source: { url, run_id } }
 *
 * The engine calls it after a finding that has cards passes on two runs in a
 * row, with the card ids the import reply gave it. Auth and org resolution
 * work as in the import route. The VAULT_SERVICE_TOKEN bearer alone
 * authenticates, and the org comes from the path, by id or slug.
 *
 * The reply has one entry per request item, in request order:
 * - `closed`: a reports-owned card still in triage moved to done and got the
 *   `finding_resolved` entry. Triage is the only lane that counts as not
 *   started. To Do is the queue the Super Agent claims from, and the import
 *   puts delegated cards there.
 * - `noted`: any other card got the entry and kept its lane. That covers cards
 *   in progress, in review, done or archived, and cards a member created.
 * - `skipped`: the org dismissed the card by deleting it from its board. The
 *   route writes nothing, as the import does for a dismissed finding.
 * - `not_found`: no card with that id in this org. Another org's card, a
 *   hard-deleted card and a Jira run's anchor all look the same, so nothing
 *   about other orgs leaks.
 *
 * The route resolves a repeated id once, and its later entries repeat that
 * outcome. `source.run_id` makes the call safe to retry. A card carries at
 * most one entry per run_id, and a replay writes nothing and gets the first
 * call's outcome back. Each card commits on its own, so a failure part-way
 * returns a 500 with the earlier cards resolved, and a retry with the same
 * run_id picks up the rest.
 */

type Variables = {
  studioContext: StudioContext;
};

export const resolveBodySchema = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(200) })).max(100),
  source: z.object({
    url: z.string().min(1).max(500),
    run_id: z.string().min(1).max(200),
  }),
});

type Outcome = FindingResolution["outcome"];

export const createTaskBoardResolveRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/internal/task-board/resolve", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isVaultServiceToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const parsed = resolveBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const { items, source } = parsed.data;

    const outcomes = new Map<string, Outcome>();
    const counts: Record<Outcome, number> = {
      closed: 0,
      noted: 0,
      skipped: 0,
      not_found: 0,
    };
    let replayed = 0;
    const reply: { id: string; outcome: Outcome }[] = [];
    for (const { id } of items) {
      let outcome = outcomes.get(id);
      if (!outcome) {
        const resolution = await ctx.storage.taskBoard.resolveFinding({
          id,
          organizationId,
          url: source.url,
          runId: source.run_id,
        });
        outcome = resolution.outcome;
        outcomes.set(id, outcome);
        counts[outcome]++;
        if (resolution.replayed) replayed++;
        if (resolution.item) {
          emitTaskBoardUpdated(organizationId, resolution.item);
        }
      }
      reply.push({ id, outcome });
    }

    if (outcomes.size > 0) {
      // Receiver's side of the engine's resolve call. Counts are per distinct
      // card, replays included, so a retried batch reports the same numbers.
      // Join on run_id, never sum.
      captureOrgEvent({
        event: "task_board_resolve_landed",
        organizationId,
        properties: {
          ...counts,
          replayed,
          run_id: source.run_id,
          source_url: source.url,
        },
      });
    }

    return c.json({ items: reply });
  });

  return app;
};
