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
import { sql } from "kysely";
import { auth, getTrustedOrigins, grantDeploymentAdmin } from "@/auth";
import { isAlreadyMemberError } from "@/auth/is-already-member-error";
import { BUILTIN_ROLES, type BuiltinRole } from "@decocms/shared/auth/roles";
import { taskQuotaState } from "@/billing/task-quota";
import { LIVE_CLAIM_FILTER } from "@/storage/organization-billing";
import { getDb } from "@/database";
import { posthog } from "@/posthog";
import { getSettings } from "@/settings";
import type { Env } from "@/api/hono-env";

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
  // `taskQuotaEnforced` gates the Billing tab: on deployments without the
  // quota gate (self-hosted) there is nothing to administer there.
  app.get("/me", (c) => {
    const email = c.get("studioContext").auth.user?.email;
    if (!email) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      email,
      taskQuotaEnforced: getSettings().taskQuotaEnforced,
    });
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
    const requested = Math.floor(Number(c.req.query("limit")));
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

  /**
   * Per-org task-quota consumption. Same clamp+search contract as /orgs, but
   * ordered by all-time live claims so the orgs actually consuming quota rank
   * first. The current bucket (trial vs subscription cycle) and its ceiling
   * are computed with the SAME `taskQuotaState` the enforcement path uses,
   * and the counts share `LIVE_CLAIM_FILTER` with it, so this view can never
   * disagree with what a dispatch would be allowed.
   *
   * Scale ceiling is the same ~10^5 orgs as /orgs (the ordering subquery is
   * an index probe per org, pre-LIMIT). Past that, /orgs's limit-first +
   * LATERAL trick does NOT apply here — the ORDER BY *is* the count — so the
   * fix is inverted: aggregate task_quota_claims first (it only has rows for
   * quota-consuming orgs), join orgs back, pad with zero-claim orgs.
   */
  app.get("/billing/orgs", async (c) => {
    const search = c.req.query("search")?.trim();
    const requested = Math.floor(Number(c.req.query("limit")));
    const limit = Math.min(requested > 0 ? requested : 100, 100);
    const db = getDb().db;
    const settings = getSettings();

    let query = db
      .selectFrom("organization")
      .leftJoin(
        "organization_billing",
        "organization_billing.organization_id",
        "organization.id",
      )
      .select([
        "organization.id as id",
        "organization.name as name",
        "organization.slug as slug",
        "organization_billing.status as status",
        "organization_billing.current_period_end as currentPeriodEnd",
        "organization_billing.free_task_executions as freeTaskExecutions",
        "organization_billing.monthly_task_executions as monthlyTaskExecutions",
      ])
      .select((eb) =>
        eb
          .selectFrom("task_quota_claims")
          .select((eb2) => eb2.fn.countAll<string>().as("count"))
          .whereRef("task_quota_claims.organization_id", "=", "organization.id")
          .where(...LIVE_CLAIM_FILTER)
          .as("totalClaims"),
      );

    if (search) {
      query = query.where((eb) =>
        eb.or([
          eb("organization.name", "ilike", `%${search}%`),
          eb("organization.slug", "ilike", `%${search}%`),
        ]),
      );
    }

    const rows = await query
      .orderBy(sql.ref("totalClaims"), "desc")
      .orderBy("organization.createdAt", "desc")
      .limit(limit)
      .execute();

    // Used-in-current-bucket, one grouped query for the page (no N+1); the
    // right bucket per org is picked in JS because it depends on each org's
    // subscription state.
    const counts = await c
      .get("studioContext")
      .storage.organizationBilling.liveClaimCountsByPeriod(
        rows.map((row) => row.id),
      );
    const usedByOrgPeriod = new Map(
      counts.map(
        (row) => [`${row.organizationId} ${row.periodKey}`, row.count] as const,
      ),
    );

    return c.json({
      defaults: {
        freeTaskExecutions: settings.freeTaskExecutions,
        monthlyTaskExecutions: settings.monthlyTaskExecutions,
      },
      organizations: rows.map((row) => {
        const billing =
          row.status == null
            ? null
            : {
                status: row.status,
                currentPeriodEnd: row.currentPeriodEnd,
                freeTaskExecutions: row.freeTaskExecutions,
                monthlyTaskExecutions: row.monthlyTaskExecutions,
              };
        const quota = taskQuotaState(billing, settings);
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status ?? "none",
          currentPeriodEnd: row.currentPeriodEnd,
          periodKey: quota.periodKey,
          used: usedByOrgPeriod.get(`${row.id} ${quota.periodKey}`) ?? 0,
          limit: quota.limit,
          freeTaskExecutions: row.freeTaskExecutions,
          monthlyTaskExecutions: row.monthlyTaskExecutions,
          totalClaims: Number(row.totalClaims ?? 0),
        };
      }),
    });
  });

  /**
   * Set/clear an org's quota overrides (migration 164's operator action —
   * deliberately not an MCP tool so an org admin can never raise their own
   * limit). null resets a knob to the deployment default; an omitted field is
   * left untouched. Deliberately usable while the quota gate is off: the
   * columns are dormant then, and an override set ahead of enabling the gate
   * should stick.
   */
  app.patch("/billing/orgs/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    // `?? {}`: a body of JSON `null` parses fine and would explode on the
    // property reads below.
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
      freeTaskExecutions?: unknown;
      monthlyTaskExecutions?: unknown;
    };
    // undefined = don't touch, null = reset to default, else a positive int4
    // (the DB rejects 0/negative/overflow too, but with a 500).
    const parse = (value: unknown): number | null | undefined | "invalid" =>
      value === undefined
        ? undefined
        : value === null
          ? null
          : typeof value === "number" &&
              Number.isInteger(value) &&
              value > 0 &&
              value <= 2_147_483_647
            ? value
            : "invalid";
    const free = parse(body.freeTaskExecutions);
    const monthly = parse(body.monthlyTaskExecutions);
    if (
      free === "invalid" ||
      monthly === "invalid" ||
      (free === undefined && monthly === undefined)
    ) {
      return c.json(
        {
          error:
            "freeTaskExecutions / monthlyTaskExecutions must be a positive integer or null (null = deployment default)",
        },
        400,
      );
    }

    const org = await getDb()
      .db.selectFrom("organization")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) return c.json({ error: "Organization not found" }, 404);

    // Previous values first, so the audit line can reconstruct a lowered
    // quota without DB history.
    const billing = c.get("studioContext").storage.organizationBilling;
    const previous = await billing.getBilling(orgId);
    await billing.setQuotaOverrides(orgId, {
      freeTaskExecutions: free,
      monthlyTaskExecutions: monthly,
    });

    // Changing what a tenant is entitled to is a privileged action — audit it
    // like /impersonate and member-add, attributed to the REAL actor.
    const { actorId: effectiveActorId, impersonatedBy } =
      await getAuditActor(c);
    const actorId = impersonatedBy ?? effectiveActorId;
    auditAdminAction("quota_update", {
      actor_user_id: actorId,
      ...(impersonatedBy ? { impersonated_user_id: effectiveActorId } : {}),
      organization_id: orgId,
      free_task_executions: free,
      monthly_task_executions: monthly,
      previous_free_task_executions: previous?.freeTaskExecutions ?? null,
      previous_monthly_task_executions: previous?.monthlyTaskExecutions ?? null,
    });
    posthog.capture({
      distinctId: actorId ?? orgId,
      event: "deployment_admin_quota_updated",
      groups: { organization: orgId },
      properties: {
        actor_user_id: actorId,
        organization_id: orgId,
        free_task_executions: free,
        monthly_task_executions: monthly,
      },
    });

    return c.json({ ok: true });
  });

  return app;
}
