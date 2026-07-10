/**
 * Deployment Admin Routes
 *
 * Instance-level admin surface for operators (debugging a user's issue, fixing
 * org membership) — gated by `DEPLOYMENT_ADMIN_EMAILS`, not by any per-org
 * role. Every endpoint lives behind `requireDeploymentAdmin`, and the raw
 * Better Auth admin plugin (`/api/auth/admin/*`) is fenced off in `app.ts` so
 * a pushed `adminUserIds` id can't reach set-role / set-user-password / etc.
 * directly. The one exception the client hits directly is
 * `authClient.admin.stopImpersonating()`, which needs no admin permission.
 *
 * Impersonation and member-add are audited via PostHog (actor + target), the
 * same way the org tools capture privileged actions.
 *
 * Route: /api/_admin/* (underscore keeps it out of the org-slug namespace).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { auth, deploymentAdminUserIds } from "@/auth";
import { isAlreadyMemberError } from "@/auth/is-already-member-error";
import { BUILTIN_ROLES, type BuiltinRole } from "@/auth/roles";
import { getDb } from "@/database";
import { posthog } from "@/posthog";
import { getSettings } from "@/settings";
import type { Env } from "@/api/hono-env";

async function requireDeploymentAdmin(
  c: Context<Env>,
  next: () => Promise<void>,
) {
  const user = c.get("meshContext").auth.user;
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!user.emailVerified) {
    // Distinct code so the operator knows to verify their email, not that
    // they're missing from the allowlist.
    return c.json({ error: "email_not_verified" }, 401);
  }
  const email = user.email?.toLowerCase();
  if (!email || !getSettings().deploymentAdminEmails.includes(email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!deploymentAdminUserIds.includes(user.id)) {
    deploymentAdminUserIds.push(user.id);
  }
  return next();
}

export function createAdminRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", requireDeploymentAdmin);

  // The middleware IS the check — the UI gate just probes this.
  app.get("/me", (c) => {
    const email = c.get("meshContext").auth.user?.email;
    if (!email) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ email });
  });

  app.get("/users", async (c) => {
    // Whitelist + clamp rather than forwarding c.req.query() raw: an omitted
    // `limit` otherwise makes better-auth return the entire user table, and the
    // raw passthrough couples this endpoint's contract to the plugin's schema.
    const searchValue = c.req.query("searchValue");
    const requested = Number(c.req.query("limit"));
    const limit = Math.min(requested > 0 ? requested : 100, 100);
    const result = await auth.api.listUsers({
      query: { limit: String(limit), ...(searchValue ? { searchValue } : {}) },
      headers: c.req.raw.headers,
    });
    return c.json(result);
  });

  app.post("/impersonate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: unknown;
    };
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    // Impersonating while already impersonating would overwrite the signed
    // admin_session restore cookie with the CURRENT (impersonated) session,
    // stranding the original admin's path back. Stop first.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const impersonatedBy = (
      session?.session as { impersonatedBy?: string } | undefined
    )?.impersonatedBy;
    if (impersonatedBy) {
      return c.json(
        { error: "Already impersonating — stop impersonating first" },
        409,
      );
    }

    // asResponse forwards the Set-Cookie headers (new session + admin_session
    // restore cookie) verbatim, and converts a thrown APIError into an error
    // Response instead of throwing — safe to return directly either way.
    const res = await auth.api.impersonateUser({
      body: { userId },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (res.ok) {
      const actorId = c.get("meshContext").auth.user?.id;
      posthog.capture({
        distinctId: actorId ?? userId,
        event: "deployment_admin_impersonated",
        properties: { actor_user_id: actorId, target_user_id: userId },
      });
    }

    return res;
  });

  app.get("/orgs", async (c) => {
    const db = getDb().db;
    const rows = await db
      .selectFrom("organization")
      .leftJoin("member", "member.organizationId", "organization.id")
      .select([
        "organization.id as id",
        "organization.name as name",
        "organization.slug as slug",
        "organization.createdAt as createdAt",
      ])
      .select((eb) => eb.fn.count<string>("member.id").as("memberCount"))
      .groupBy([
        "organization.id",
        "organization.name",
        "organization.slug",
        "organization.createdAt",
      ])
      .orderBy("organization.createdAt", "desc")
      .execute();

    return c.json({
      organizations: rows.map((row) => ({
        ...row,
        memberCount: Number(row.memberCount || 0),
      })),
    });
  });

  app.post("/orgs/:orgId/members", async (c) => {
    const orgId = c.req.param("orgId");
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: unknown;
      role?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" ? body.role : "";
    if (!email || !BUILTIN_ROLES.includes(role as BuiltinRole)) {
      return c.json({ error: "Valid email and role are required" }, 400);
    }

    const user = await getDb()
      .db.selectFrom("user")
      .select(["id"])
      .where("email", "=", email)
      .executeTakeFirst();
    if (!user) {
      return c.json(
        { error: "No user with that email — they must sign up first" },
        404,
      );
    }

    try {
      // Headerless: a trusted server-side call, same proven bypass used by
      // ensure-user-organization.ts and the domain-join endpoint. A bad orgId
      // throws an APIError that handleApiError maps to its real status.
      await auth.api.addMember({
        body: { userId: user.id, organizationId: orgId, role },
      });
    } catch (error) {
      if (isAlreadyMemberError(error)) {
        return c.json({ error: "User is already a member of this org" }, 409);
      }
      throw error;
    }

    const actorId = c.get("meshContext").auth.user?.id;
    posthog.capture({
      distinctId: actorId ?? user.id,
      event: "deployment_admin_member_added",
      groups: { organization: orgId },
      properties: {
        actor_user_id: actorId,
        organization_id: orgId,
        added_user_id: user.id,
        role,
      },
    });

    return c.json({ ok: true });
  });

  return app;
}
