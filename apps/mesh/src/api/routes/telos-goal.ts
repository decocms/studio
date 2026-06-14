// GET /api/:org/telos-goal → { goal, facts, status }
// POST /api/:org/telos-facts/:id → confirm/reject a fact
//
// No goal yet → publish a user.signup trigger (durable, OAOO), which also
// backfills orgs predating the signup hook; the client updates live via SSE.

import type { StudioContext } from "@/core/studio-context";
import { telosBus } from "@/telos/durable/bus";
import { FactStore, type FactStatus } from "@/telos/fact-store";
import { KyselyGoalLedger } from "@/telos/ledger";
import { RESEARCH_EMAIL } from "@/telos/research";
import { Hono } from "hono";

type Variables = { meshContext: StudioContext };

export function createTelosGoalRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/telos-goal", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const ledger = new KyselyGoalLedger(mesh.db);
    const factStore = new FactStore(mesh.db);

    const [anchor, facts] = await Promise.all([
      ledger.anchor(orgId).catch(() => null),
      factStore.list(orgId),
    ]);

    const goal = anchor
      ? { ...anchor.target, version: anchor.version, source: anchor.source }
      : null;

    // No goal yet → kick the durable research capability (OAOO-deduped).
    if (!goal) {
      await telosBus.publish({
        type: "user.signup",
        organizationId: orgId,
        userId: mesh.auth.user?.id ?? "",
        email: RESEARCH_EMAIL,
      });
    }

    return c.json({ goal, facts, status: goal ? "ready" : "researching" });
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

    await new FactStore(mesh.db).setStatus(orgId, c.req.param("id"), status);
    await telosBus.publish({ type: "facts.updated", organizationId: orgId });
    return c.json({ ok: true });
  });

  return app;
}
