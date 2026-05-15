/**
 * Home Board API Routes
 *
 * Org-scoped, per-user. Mounted under `/api/:org` so `resolveOrgFromPath`
 * populates `meshContext.organization`; the authenticated user is read
 * from `meshContext.auth.user`.
 *
 *   GET    /home-board                     → { tiles }
 *   PATCH  /home-board/tiles/:tileId       → { tile } (move/resize, partial)
 *   DELETE /home-board/tiles/:tileId       → { ok: true }
 *
 * Auto-pin happens server-side in `POST /preset-tasks/:id/start`; this
 * router does not expose a POST for tile creation. If we ever need a
 * client-add path it lands here.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { MeshContext } from "@/core/mesh-context";
import type { HomeBoardStore } from "@/storage/home-board";

interface HomeBoardRouteDeps {
  store: HomeBoardStore;
}

type Variables = {
  meshContext: MeshContext;
};

const PatchBody = z.object({
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  w: z.number().int().min(1).optional(),
  h: z.number().int().min(1).optional(),
});

export function createHomeBoardRoutes(deps: HomeBoardRouteDeps) {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/home-board", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);
    const board = await deps.store.get(orgId, userId);
    return c.json(board);
  });

  app.patch("/home-board/tiles/:tileId", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);
    const tileId = c.req.param("tileId");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid patch", issues: parsed.error.issues },
        400,
      );
    }
    const updated = await deps.store.updateTile(
      orgId,
      userId,
      tileId,
      parsed.data,
    );
    if (!updated) return c.json({ error: "Tile not found" }, 404);
    return c.json({ tile: updated });
  });

  app.delete("/home-board", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);
    await deps.store.set(orgId, userId, { tiles: [] });
    return c.json({ ok: true });
  });

  app.delete("/home-board/tiles/:tileId", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);
    const tileId = c.req.param("tileId");
    const removed = await deps.store.removeTile(orgId, userId, tileId);
    if (!removed) return c.json({ error: "Tile not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
