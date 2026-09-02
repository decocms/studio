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
 * Impersonation and member-add are audited two ways: a durable stdout line
 * (captured in every deployment's logs — the self-hosts this surface targets
 * often run without PostHog) plus a PostHog event, the same way the org tools
 * capture privileged actions.
 *
 * Route: `ADMIN_API_PREFIX`/* (underscore keeps it out of the org-slug
 * namespace). The prefix is exported so the mount and the SSO-enforcement
 * exemption in app.ts share one source — see the constant below.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { auth, getTrustedOrigins, grantDeploymentAdmin } from "@/auth";
import { isAlreadyMemberError } from "@/auth/is-already-member-error";
import { BUILTIN_ROLES, type BuiltinRole } from "@decocms/shared/auth/roles";
import { getDb } from "@/database";
import { OrganizationSettingsStorage } from "@/storage/organization-settings";
import { OrgSiteConflictError, OrgSiteStorage } from "@/storage/org-sites";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import {
  flagsResponse,
  type OrgFlagsPatch,
  OrgFlagsPatchSchema,
} from "./admin-flags";
import { posthog } from "@/posthog";
import { getSettings } from "@/settings";
import type { Env } from "@/api/hono-env";
import { createAdminPromptRoutes } from "./admin-prompts";

/**
 * Mount path for the deployment-admin surface. Single source of truth: app.ts
 * mounts the router here AND exempts this prefix from SSO enforcement. Matching
 * by prefix means any endpoint added under this router is automatically fenced
 * (the sub-app's `app.use("*", requireDeploymentAdmin)`) and SSO-exempt — no
 * second edit anywhere. Change the path here and both move together.
 */
export const ADMIN_API_PREFIX = "/api/_admin";

/**
 * Fence for the raw Better Auth admin plugin (`/api/auth/admin/*`), mounted in
 * app.ts BEFORE the catch-all auth handler. Every deployment-admin action goes
 * through `/api/_admin/*` (which calls `auth.api.*` in-process), so the only
 * admin-plugin endpoint the browser legitimately hits directly is
 * stop-impersonating (needs no admin permission). Leaving the rest reachable
 * would let any id pushed into deploymentAdminUserIds (see @/auth) call
 * set-role / set-user-password / ban-user etc. directly — a permanent,
 * restart-surviving escalation past the DEPLOYMENT_ADMIN_EMAILS allowlist.
 * 404 (not 403) so the surface isn't advertised.
 *
 * Lives here (not inline in app.ts) so the fence and the routes it protects
 * are one module: deleting or refactoring this file breaks the app.ts import
 * instead of silently leaving the raw surface open.
 */
export function fenceRawAdminSurface(
  c: Context<Env>,
  next: () => Promise<void>,
) {
  if (c.req.path === "/api/auth/admin/stop-impersonating") {
    return next();
  }
  return c.json({ error: "Not Found", path: c.req.path }, 404);
}

/**
 * CSRF defense-in-depth for the mutating admin routes. What actually blocks a
 * cross-site POST today is the session cookie's `SameSite=Lax` — better-auth's
 * default, configured nowhere near this file. If that ever changes (e.g.
 * `crossSubDomainCookies` forces `SameSite=None`), a page on any origin could
 * fire /impersonate with a logged-in admin's cookie. Browsers always send
 * `Origin` on cross-site POSTs, so rejecting untrusted origins closes that
 * hole; requests without an Origin header (curl, server-to-server) are not
 * CSRF and pass through to the session check.
 */
async function rejectUntrustedOrigin(
  c: Context<Env>,
  next: () => Promise<void>,
) {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && !getTrustedOrigins().includes(origin)) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  return next();
}

/**
 * Durable audit line for a privileged deployment-admin action. Impersonating a
 * user or granting org membership are the highest-blast-radius actions in the
 * product; stdout is the one sink present in every deployment (PostHog can be
 * unconfigured or sampled), so it's the non-negotiable trail.
 */
function auditAdminAction(action: string, props: Record<string, unknown>) {
  console.log("deployment_admin_action", { action, ...props });
}

/**
 * The REAL actor for audit purposes. Under impersonation the session user (and
 * studioContext.auth.user) is the impersonation TARGET — an admin impersonating
 * a fellow admin can reach every /api/_admin route, and attributing their
 * actions to the impersonated identity would defeat the audit trail. The
 * original admin's id lives in `session.impersonatedBy`.
 */
async function getAuditActor(
  c: Context<Env>,
): Promise<{ actorId?: string; impersonatedBy?: string }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return {
    actorId: c.get("studioContext").auth.user?.id,
    impersonatedBy: (
      session?.session as { impersonatedBy?: string } | undefined
    )?.impersonatedBy,
  };
}

/**
 * Overwrite an org's entire flags bag (raw-JSON editor "replace" mode). Unlike
 * the merge upsert, a key absent from `flags` is deleted, restoring "unset"
 * semantics. Insert-or-replace so it works before a settings row exists.
 */
async function replaceOrgFlags(
  db: ReturnType<typeof getDb>["db"],
  orgId: string,
  flags: OrgFlagsPatch,
): Promise<void> {
  const now = new Date().toISOString();
  const serialized = JSON.stringify(flags);
  await db
    .insertInto("organization_settings")
    .values({
      organizationId: orgId,
      flags: serialized,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.column("organizationId").doUpdateSet({
        flags: serialized,
        updatedAt: now,
      }),
    )
    .execute();
}

async function requireDeploymentAdmin(
  c: Context<Env>,
  next: () => Promise<void>,
) {
  const user = c.get("studioContext").auth.user;
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const email = user.email?.toLowerCase();
  if (!email || !getSettings().deploymentAdminEmails.includes(email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!user.emailVerified) {
    // Allowlisted but unverified: distinct code so the operator knows to
    // verify their email, not that they're missing from the allowlist.
    // Checked AFTER the allowlist so a random (typically unverified) signup
    // gets the plain 403, not a misleading "verify your email" hint.
    return c.json({ error: "email_not_verified" }, 401);
  }
  grantDeploymentAdmin(user.id);
  return next();
}

export function createAdminRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", rejectUntrustedOrigin);
  app.use("*", requireDeploymentAdmin);

  // The middleware IS the check — the UI gate just probes this.
  app.get("/me", (c) => {
    const email = c.get("studioContext").auth.user?.email;
    if (!email) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ email });
  });

  app.get("/users", async (c) => {
    // Whitelist + clamp rather than forwarding c.req.query() raw: an omitted
    // `limit` otherwise makes better-auth return the entire user table, and the
    // raw passthrough couples this endpoint's contract to the plugin's schema.
    const searchValue = c.req.query("searchValue")?.trim();
    const requested = Number(c.req.query("limit"));
    const limit = Math.min(requested > 0 ? requested : 100, 100);
    const headers = c.req.raw.headers;

    // Project to the fields the dashboard renders instead of forwarding
    // better-auth's raw rows: the plugin payload carries admin-plugin columns
    // (role, banned, banReason, ...) this surface doesn't expose, and an
    // explicit projection keeps the wire contract stable across plugin bumps.
    const project = (u: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      emailVerified: boolean;
      createdAt: Date;
    }) => ({
      id: u.id,
      email: u.email,
      name: u.name ?? null,
      image: u.image ?? null,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt,
    });

    if (!searchValue) {
      const { users } = await auth.api.listUsers({
        query: { limit: String(limit) },
        headers,
      });
      return c.json({ users: users.map(project) });
    }

    // better-auth's listUsers searches ONE field per call (searchField), so a
    // single probe can't honor the UI's "email or name" search. Probe both and
    // merge (deduped by id, later wins) so the search does what it says.
    const [byEmail, byName] = await Promise.all([
      auth.api.listUsers({
        query: { limit: String(limit), searchValue, searchField: "email" },
        headers,
      }),
      auth.api.listUsers({
        query: { limit: String(limit), searchValue, searchField: "name" },
        headers,
      }),
    ]);
    const merged = new Map(
      [...byEmail.users, ...byName.users].map((u) => [u.id, u] as const),
    );
    const users = [...merged.values()].slice(0, limit).map(project);
    return c.json({ users });
  });

  app.post("/impersonate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: unknown;
    };
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    // The UI disables the button for the current user, but the server is the
    // trust boundary — self-impersonation would set impersonatedBy = self.
    if (userId === c.get("studioContext").auth.user?.id) {
      return c.json({ error: "Cannot impersonate yourself" }, 400);
    }

    // Impersonating while already impersonating would overwrite the signed
    // admin_session restore cookie with the CURRENT (impersonated) session,
    // stranding the original admin's path back. Stop first.
    const { impersonatedBy } = await getAuditActor(c);
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
      const actorId = c.get("studioContext").auth.user?.id;
      auditAdminAction("impersonate", {
        actor_user_id: actorId,
        target_user_id: userId,
      });
      posthog.capture({
        distinctId: actorId ?? userId,
        event: "deployment_admin_impersonated",
        properties: { actor_user_id: actorId, target_user_id: userId },
      });
    }

    return res;
  });

  app.get("/orgs", async (c) => {
    // Clamp + search, same shape as /users: every signup mints a personal org,
    // so the table is ~user-count. An unbounded load (plus a per-row dialog in
    // the UI) would degrade at a few thousand orgs.
    //
    // The count aggregates the whole member table before LIMIT — fine to
    // ~10^5 member rows; past that, switch to limit-first + LATERAL count and
    // add an index on member(organizationId).
    const search = c.req.query("search")?.trim();
    const requested = Number(c.req.query("limit"));
    const limit = Math.min(requested > 0 ? requested : 100, 100);
    const db = getDb().db;

    let query = db
      .selectFrom("organization")
      .leftJoin("member", "member.organizationId", "organization.id")
      .select([
        "organization.id as id",
        "organization.name as name",
        "organization.slug as slug",
        "organization.createdAt as createdAt",
      ])
      .select((eb) => eb.fn.count<string>("member.id").as("memberCount"));

    if (search) {
      // Parameterized by Kysely; `%`/`_` in the term just widen the match.
      query = query.where((eb) =>
        eb.or([
          eb("organization.name", "ilike", `%${search}%`),
          eb("organization.slug", "ilike", `%${search}%`),
        ]),
      );
    }

    const rows = await query
      .groupBy([
        "organization.id",
        "organization.name",
        "organization.slug",
        "organization.createdAt",
      ])
      .orderBy("organization.createdAt", "desc")
      .limit(limit)
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

    // Unlike /impersonate (which 409s while impersonating), this route IS
    // reachable by an admin impersonating a fellow admin — attribute to the
    // real actor, not the impersonated identity.
    const { actorId: effectiveActorId, impersonatedBy } =
      await getAuditActor(c);
    const actorId = impersonatedBy ?? effectiveActorId;
    auditAdminAction("member_add", {
      actor_user_id: actorId,
      ...(impersonatedBy ? { impersonated_user_id: effectiveActorId } : {}),
      organization_id: orgId,
      added_user_id: user.id,
      role,
    });
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

  // Feature-flag editor over `organization_settings.flags`; OrgFlagsSchema is the source of truth.
  app.get("/orgs/:orgId/flags", async (c) => {
    const orgId = c.req.param("orgId");
    const db = getDb().db;
    const org = await db
      .selectFrom("organization")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }
    const settings = await new OrganizationSettingsStorage(db).get(orgId);
    return c.json(flagsResponse(settings?.flags ?? null));
  });

  app.put("/orgs/:orgId/flags", async (c) => {
    const orgId = c.req.param("orgId");
    const raw = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "Invalid body" }, 400);
    }
    const body = raw as { flags?: unknown; mode?: unknown };
    // "replace" overwrites the whole bag (raw-JSON editor); "merge" (default) keeps omitted keys.
    if (
      body.mode !== undefined &&
      body.mode !== "merge" &&
      body.mode !== "replace"
    ) {
      return c.json({ error: "Invalid mode" }, 400);
    }
    const mode = body.mode === "replace" ? "replace" : "merge";
    const parsed = OrgFlagsPatchSchema.safeParse(body.flags ?? {});
    if (!parsed.success) {
      return c.json(
        { error: "Invalid flags", issues: parsed.error.issues },
        400,
      );
    }

    const db = getDb().db;
    const org = await db
      .selectFrom("organization")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (mode === "replace") {
      await replaceOrgFlags(db, orgId, parsed.data);
    } else {
      // Shallow jsonb merge (`coalesce(flags,'{}') || $new`).
      await new OrganizationSettingsStorage(db).upsert(orgId, {
        flags: parsed.data,
      });
    }
    const settings = await new OrganizationSettingsStorage(db).get(orgId);

    // Same real-actor attribution as member_add (reachable while impersonating).
    const { actorId: effectiveActorId, impersonatedBy } =
      await getAuditActor(c);
    const actorId = impersonatedBy ?? effectiveActorId;
    auditAdminAction("org_flags_update", {
      actor_user_id: actorId,
      ...(impersonatedBy ? { impersonated_user_id: effectiveActorId } : {}),
      organization_id: orgId,
      mode,
      flags: parsed.data,
    });
    posthog.capture({
      distinctId: actorId ?? orgId,
      event: "deployment_admin_org_flags_updated",
      groups: { organization: orgId },
      properties: {
        actor_user_id: actorId,
        organization_id: orgId,
        mode,
        flags: parsed.data,
      },
    });

    return c.json(flagsResponse(settings?.flags ?? null));
  });

  // Site ownership (org_sites): which org owns a globally-unique slug, the gate behind Hosting/E2E/Analytics/Monitor.
  app.get("/orgs/:orgId/sites", async (c) => {
    const orgId = c.req.param("orgId");
    const db = getDb().db;
    const org = await db
      .selectFrom("organization")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }
    const sites = await new OrgSiteStorage(db).listByOrg(orgId);
    return c.json({ sites });
  });

  app.post("/orgs/:orgId/sites", async (c) => {
    const orgId = c.req.param("orgId");
    const raw = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "Invalid body" }, 400);
    }
    const body = raw as { slug?: unknown; reassign?: unknown };
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!isValidSiteSlug(slug)) {
      return c.json({ error: "Invalid site slug" }, 400);
    }
    const reassign = body.reassign === true;

    const db = getDb().db;
    const org = await db
      .selectFrom("organization")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const { actorId: effectiveActorId, impersonatedBy } =
      await getAuditActor(c);
    const actorId = impersonatedBy ?? effectiveActorId;
    if (!actorId) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const storage = new OrgSiteStorage(db);

    const audit = (action: string, extra: Record<string, unknown>) => {
      auditAdminAction(action, {
        actor_user_id: actorId,
        ...(impersonatedBy ? { impersonated_user_id: effectiveActorId } : {}),
        organization_id: orgId,
        slug,
        ...extra,
      });
      posthog.capture({
        distinctId: actorId,
        event: `deployment_admin_${action}`,
        groups: { organization: orgId },
        properties: { actor_user_id: actorId, organization_id: orgId, slug },
      });
    };

    try {
      const site = await storage.claimSite({
        slug,
        organizationId: orgId,
        source: "manual",
        by: actorId,
      });
      audit("org_site_claim", {});
      return c.json({ site });
    } catch (error) {
      if (!(error instanceof OrgSiteConflictError)) throw error;
      // Owned by another org: refuse unless the caller explicitly confirms the move.
      if (!reassign) {
        const owner = await db
          .selectFrom("organization")
          .select(["name", "slug"])
          .where("id", "=", error.ownerOrganizationId)
          .executeTakeFirst();
        return c.json(
          {
            error: "owned_by_other_org",
            ownerOrganizationId: error.ownerOrganizationId,
            ownerOrganizationName: owner?.name ?? null,
            ownerOrganizationSlug: owner?.slug ?? null,
          },
          409,
        );
      }
      const site = await storage.reassignSite({
        slug,
        organizationId: orgId,
        source: "manual",
        by: actorId,
      });
      audit("org_site_reassign", {
        from_organization_id: error.ownerOrganizationId,
      });
      return c.json({ site, reassignedFrom: error.ownerOrganizationId });
    }
  });

  app.delete("/orgs/:orgId/sites/:slug", async (c) => {
    const orgId = c.req.param("orgId");
    const slug = c.req.param("slug");
    const db = getDb().db;
    const org = await db
      .selectFrom("organization")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const { actorId: effectiveActorId, impersonatedBy } =
      await getAuditActor(c);
    const actorId = impersonatedBy ?? effectiveActorId;
    if (!actorId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const released = await new OrgSiteStorage(db).releaseSite(slug, orgId);
    if (!released) {
      return c.json({ error: "Site not found for this organization" }, 404);
    }

    auditAdminAction("org_site_release", {
      actor_user_id: actorId,
      ...(impersonatedBy ? { impersonated_user_id: effectiveActorId } : {}),
      organization_id: orgId,
      slug,
    });
    posthog.capture({
      distinctId: actorId ?? orgId,
      event: "deployment_admin_org_site_release",
      groups: { organization: orgId },
      properties: { actor_user_id: actorId, organization_id: orgId, slug },
    });

    return c.json({ ok: true });
  });

  // The agent-prompt editor (reads/writes decocms/studio over GitHub) — its own
  // module, mounted here so it inherits this router's admin fence.
  app.route("/", createAdminPromptRoutes());

  return app;
}
