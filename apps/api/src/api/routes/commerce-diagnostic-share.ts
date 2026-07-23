import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getCommerceDiscoveryAgentId,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";
import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import { getBaseUrl } from "@/core/server-constants";
import type { StudioContext } from "@/core/studio-context";
import { bearerToken, isVaultServiceToken } from "./credential-vault";

/**
 * Commerce-diagnostic share invite — the "different invite path" behind the
 * Share button on a claimed (private) diagnostic.
 *
 *   POST /api/:org/internal/commerce-diagnostic/share-invite
 *
 * Auth mirrors the task-board import + credential vault: the shared
 * VAULT_SERVICE_TOKEN bearer alone authenticates (constant-time compare), the
 * org is resolved by id from the path (see SERVICE_TOKEN_ROUTES). The caller is
 * commerce-discovery's `share_my_diagnostic` tool.
 *
 * Why a bespoke path instead of Better Auth's `inviteMember`:
 * `createInvitation` unconditionally fires the org plugin's generic
 * `sendInvitationEmail`. The share flow needs a *different* email — one with a
 * preview of the private diagnostic — sent by commerce-discovery (it owns the
 * diagnostic data + the branded report-email template). So we create the
 * invitation row directly (no generic email) and hand the caller the accept
 * URL; commerce-discovery sends the preview email with that URL as its CTA.
 *
 * The accept URL's `redirectTo` is the org-home deep link that OPENS the
 * diagnostic app view — the exact shape `commerceReportNavTarget()`
 * (web/hooks/use-commerce-diagnostic.ts) and setup.ts's completion-email link
 * build: `/{slug}/{taskId}?virtualmcpid=..&main=app:{conn}:get_my_diagnostic`.
 *
 * Branching by invitee (requirement: "invite to studio, or if already a user
 * only invite for the org"): an existing user who is already a member of this
 * org needs no invitation — they get the deep link straight away
 * (`invitee_status: "member"`). Everyone else gets a pending invitation
 * (`"existing"` when they already have a Studio account, `"new"` otherwise);
 * Better Auth branches signup-vs-accept at accept time.
 */

type Variables = {
  studioContext: StudioContext;
};

export const shareInviteBodySchema = z.object({
  invitee_email: z.string().trim().email().max(320),
});

/** Org-home deep link that opens the org's commerce-diagnostic app view.
 *  Mirrors commerceReportNavTarget() and setup.ts's completion-email link.
 *  Relative (path + query) so it is a safe `redirectTo` (login.tsx rejects
 *  absolute/protocol-relative targets). Exported for unit tests. */
export function diagnosticDeepLinkPath(
  orgSlug: string,
  orgId: string,
  taskId: string,
): string {
  const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(orgId);
  const search = new URLSearchParams({
    virtualmcpid: getCommerceDiscoveryAgentId(orgId),
    main: `app:${connectionId}:${COMMERCE_DISCOVERY_REPORT_TOOL_NAME}`,
  });
  return `/${orgSlug}/${taskId}?${search.toString()}`;
}

export const createCommerceDiagnosticShareRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/internal/commerce-diagnostic/share-invite", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isVaultServiceToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const ctx = c.get("studioContext");
    const org = ctx.organization;
    if (!org?.id) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const parsed = shareInviteBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400,
      );
    }

    const email = parsed.data.invitee_email.toLowerCase();
    const db = ctx.db;

    // The deep link is `/{slug}/...` and the home resolves the org by slug, so
    // an org without a slug can't produce a working link. Slugs are non-null in
    // practice (Better Auth mints one on create); fail loud rather than emit a
    // `/{id}/...` link that 404s.
    const orgSlug = org.slug;
    if (!orgSlug) {
      return c.json({ error: "organization has no slug" }, 409);
    }

    // The deep link opens the diagnostic once the recipient is in the org. A
    // fresh taskId per share matches commerceReportNavTarget (a new home thread).
    const redirectPath = diagnosticDeepLinkPath(
      orgSlug,
      org.id,
      crypto.randomUUID(),
    );
    const baseUrl = getBaseUrl();
    const absoluteRedirect = `${baseUrl}${redirectPath}`;

    // Existing Studio account? (email is reserved in Postgres → quoted table.)
    const userRow = await sql<{ id: string }>`
      select id from "user" where lower(email) = ${email} limit 1
    `.execute(db);
    const existingUserId = userRow.rows[0]?.id;

    // Already a member of THIS org ⇒ no invite needed, deep-link straight in.
    if (existingUserId) {
      const member = await db
        .selectFrom("member")
        .select(["id"])
        .where("organizationId", "=", org.id)
        .where("userId", "=", existingUserId)
        .executeTakeFirst();
      if (member) {
        return c.json({
          invitee_status: "member" as const,
          accept_url: absoluteRedirect,
          redirect_url: absoluteRedirect,
          org_name: org.name,
          org_slug: orgSlug,
        });
      }
    }

    // Reuse a live pending invitation, else insert one. This collapses repeated
    // shares of the same diagnostic to one row in the common (serial) case; two
    // truly-concurrent shares to the same email can still both miss the select
    // and insert — there's no unique constraint to dedup them, and accepting
    // either lands the recipient in the org, so the duplicate is harmless.
    // The invitation table is Better-Auth-managed and not in the Kysely schema,
    // so it's raw SQL (camelCase columns are quoted). This is the path that
    // bypasses the generic sendInvitationEmail — see the header comment.
    const existing = await sql<{ id: string }>`
      select id from invitation
      where lower(email) = ${email}
        and "organizationId" = ${org.id}
        and status = 'pending'
        and "expiresAt" > now()
      order by "expiresAt" desc
      limit 1
    `.execute(db);
    let invitationId = existing.rows[0]?.id;

    if (!invitationId) {
      // inviterId must reference a real member (threads/audits FK against it).
      // Attribute the share to the org's first owner — a live org always has one.
      const owner = await db
        .selectFrom("member")
        .select(["userId"])
        .where("organizationId", "=", org.id)
        .where("role", "=", "owner")
        .orderBy("createdAt", "asc")
        .executeTakeFirst();
      if (!owner?.userId) {
        return c.json(
          { error: "organization has no owner to attribute the invite" },
          409,
        );
      }

      invitationId = crypto.randomUUID();
      await sql`
        insert into invitation
          (id, "organizationId", email, role, status, "inviterId", "expiresAt", "createdAt")
        values
          (${invitationId}, ${org.id}, ${email}, 'user', 'pending', ${owner.userId}, now() + interval '7 days', now())
      `.execute(db);
    }

    const acceptUrl =
      `${baseUrl}/auth/accept-invitation?invitationId=${encodeURIComponent(invitationId)}` +
      `&redirectTo=${encodeURIComponent(redirectPath)}`;

    return c.json({
      invitee_status: existingUserId ? ("existing" as const) : ("new" as const),
      accept_url: acceptUrl,
      redirect_url: absoluteRedirect,
      org_name: org.name,
      org_slug: orgSlug,
    });
  });

  return app;
};
