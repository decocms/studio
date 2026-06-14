// GET /api/:org/telos-goal → { goal, facts, status }
// POST /api/:org/telos-facts/:id → confirm/reject a fact
//
// No goal yet → publish a user.signup trigger (durable, OAOO), which also
// backfills orgs predating the signup hook; the client updates live via SSE.

import type { StudioContext } from "@/core/studio-context";
import { telos } from "@/telos";
import { connectTools, onboardingProgress } from "@/telos/domain";
import { telosBus } from "@/telos/durable/bus";
import { getLatestSuggestion, pullPursuit } from "@/telos/durable/pursuit";
import { getLatestThought } from "@/telos/durable/thought";
import { requireTelosRuntime } from "@/telos/durable/runtime";
import type { FactStatus } from "@decocms/telos/postgres";
import { researchSubject } from "@/telos/research";
import { Hono } from "hono";

type Variables = { meshContext: StudioContext };

export function createTelosGoalRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/telos-goal", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const { ledger, facts: factStore } = telos();

    // The current working goal (latest of any source) — so an engine-authored
    // progression goal shows, not just the original authority anchor.
    const [current, facts] = await Promise.all([
      Promise.resolve(ledger.latest(orgId)).catch(() => null),
      factStore.list(orgId),
    ]);

    // Project the Goal to the wire shape the card consumes: title + the connect-app
    // steps' tools (the connect checklist). The full step model stays server-side.
    const goal = current
      ? {
          title: current.target.title,
          tools: connectTools(current.target),
          version: current.version,
          source: current.source,
        }
      : null;
    const suggestion = goal ? getLatestSuggestion(orgId) : null;
    // Per-tool connected/not, so the card shows real progress (GitHub ✓, CMS ◯).
    const progress = current
      ? await onboardingProgress(
          requireTelosRuntime().db,
          orgId,
          current.target,
        )
      : null;

    // No goal yet → kick onboarding (installs the fixed Goal + gathers facts),
    // OAOO-deduped on the org.
    if (!goal) {
      const subject = researchSubject(
        mesh.auth.user?.email,
        mesh.auth.user?.name,
      );
      await telosBus.publish({
        type: "user.signup",
        organizationId: orgId,
        userId: mesh.auth.user?.id ?? "",
        email: subject.email,
        name: subject.name,
      });
    }

    return c.json({
      goal,
      facts,
      suggestion,
      thought: getLatestThought(orgId),
      progress,
      status: goal ? "ready" : "researching",
    });
  });

  app.post("/telos-facts/:id", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const { status } = (await c.req.json().catch(() => ({}))) as {
      status?: FactStatus;
    };
    if (status !== "confirmed" && status !== "rejected") {
      return c.json({ error: "status must be confirmed or rejected" }, 400);
    }

    await telos().facts.setStatus(orgId, c.req.param("id"), status);
    await telosBus.publish({ type: "facts.updated", organizationId: orgId });

    // The user telling us who they are is signal. The agent observes confirmed
    // facts, so pull a pursuit cycle: it re-thinks the next step with the new fact
    // in view (a fast model produces the reasoning + picks the action). The Goal
    // itself is fixed and never changes. Debounced; never blocks the edit.
    void pullPursuit(orgId);
    return c.json({ ok: true });
  });

  return app;
}
