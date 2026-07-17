/**
 * Service-to-service org-membership check.
 *
 * Downstream apps that delegate login to Studio via OAuth (e.g.
 * system-health-agent) need to know whether the authenticated user actually
 * belongs to the organization they're claiming — not just whether the org
 * exists. Studio previously had no API for a third party to ask this; the
 * only membership endpoints were session-cookie, self-check only
 * (`org-access-status/:slug`, `my-capabilities/:slug`), which a downstream
 * *service* can't call on a user's behalf.
 *
 * This mirrors the `VAULT_SERVICE_TOKEN` pattern in credential-vault.ts: a
 * shared secret, constant-time compared, read fresh from env on every call so
 * it can be rotated without a restart. Absent ⇒ feature off (fails closed —
 * every call 401s rather than silently trusting an unconfigured caller).
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getDb } from "@/database";

/**
 * Mount path for this surface. Single source of truth: app.ts mounts the
 * router here AND exempts this prefix from SSO enforcement (this route is
 * service-token authenticated, not session-based, so no org's SSO policy
 * applies to it) — same pattern as `ADMIN_API_PREFIX` in admin.ts.
 */
export const SERVICE_MEMBERSHIP_API_PREFIX = "/api/_service";

function bearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** Constant-time string compare (for the service token). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * A trusted downstream service presenting this shared token may check
 * membership for any (orgId, userId) pair. Rotate via env.
 */
export function isServiceMembershipToken(token: string): boolean {
  const svc = process.env.SERVICE_MEMBERSHIP_TOKEN;
  return !!svc && safeEqual(token, svc);
}

/**
 * Route: GET /api/_service/organizations/:orgId/members/:userId
 * Auth:  Bearer <SERVICE_MEMBERSHIP_TOKEN>
 * Response: { isMember: boolean, role: string | null }
 *
 * `orgId`/`userId` are Better Auth's own ids (organization.id, user.id) — the
 * same ids a downstream app already has from the OAuth session and from the
 * org id it's trying to verify, so no slug lookup is needed here.
 */
export const createServiceMembershipRoutes = () => {
  const app = new Hono();

  app.get("/organizations/:orgId/members/:userId", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isServiceMembershipToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");

    const db = getDb().db;
    const membership = await db
      .selectFrom("member")
      .select(["role"])
      .where("organizationId", "=", orgId)
      .where("userId", "=", userId)
      .executeTakeFirst();

    return c.json({
      isMember: !!membership,
      role: membership?.role ?? null,
    });
  });

  return app;
};
