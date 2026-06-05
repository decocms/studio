/**
 * Role Permissions Upsert Route
 *
 * Better Auth's createRole/updateRole both reject built-in role names
 * (owner, admin, user) when options.roles defines them as predefined.
 * This endpoint bypasses that by directly upserting the organizationRole
 * row via Kysely. Only owners/admins may call it.
 *
 * POST /api/:org/role-permissions
 *   body: { role: string, permission: Record<string, string[]> }
 *   returns: { id: string }
 */

import { Hono } from "hono";
import { ADMIN_ROLES } from "../../auth/roles";
import type { StudioContext } from "../../core/studio-context";
import { getDb } from "../../database";

type Variables = { meshContext: StudioContext };

export const createRolePermissionsRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/role-permissions", async (c) => {
    const ctx = c.get("meshContext") as StudioContext;

    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const org = ctx.organization;
    if (!org) {
      return c.json({ error: "Organization context required" }, 400);
    }

    const db = getDb().db;

    // Resolve caller's role from the member table
    const membership = await db
      .selectFrom("member")
      .select(["role"])
      .where("userId", "=", ctx.auth.user.id)
      .where("organizationId", "=", org.id)
      .executeTakeFirst();

    if (!membership || !(ADMIN_ROLES as readonly string[]).includes(membership.role)) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    const body = await c.req.json<{
      role: string;
      permission: Record<string, string[]>;
    }>();

    if (!body.role || typeof body.permission !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const permissionJson = JSON.stringify(body.permission);

    const existing = await db
      .selectFrom("organizationRole")
      .select(["id"])
      .where("organizationId", "=", org.id)
      .where("role", "=", body.role)
      .executeTakeFirst();

    if (existing) {
      await db
        .updateTable("organizationRole")
        .set({ permission: permissionJson })
        .where("id", "=", existing.id)
        .execute();
      return c.json({ id: existing.id });
    }

    const id = crypto.randomUUID();
    await db
      .insertInto("organizationRole")
      .values({
        id,
        organizationId: org.id,
        role: body.role,
        permission: permissionJson,
        createdAt: new Date().toISOString(),
      })
      .execute();

    return c.json({ id });
  });

  return app;
};
