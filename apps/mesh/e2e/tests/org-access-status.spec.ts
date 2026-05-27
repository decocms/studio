/**
 * Migration of apps/mesh/src/api/routes/auth.test.ts to a real e2e spec.
 *
 * The unit test mocked `auth.api.getSession` and `auth.api.listUserInvitations`
 * to drive each branch of the endpoint's status decision. That made it
 * cheap but disconnected from the real Better Auth wiring — the very thing
 * most likely to break in production. This spec exercises every branch
 * against a real Better Auth session and a real Postgres.
 *
 * One file, no shared setup beyond a DB client: each test creates its own
 * user(s) with randomized slugs/emails so workers don't collide.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

const ENDPOINT = (slug: string) =>
  `/api/auth/custom/org-access-status/${encodeURIComponent(slug)}`;

test.describe("GET /api/auth/custom/org-access-status/:slug", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("returns 401 when unauthenticated", async ({ playwright }) => {
    // Fresh context with no cookies — never signed up.
    const anon = await newApiContext(playwright);
    const res = await anon.get(ENDPOINT(`unused-${Date.now()}`));
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("returns not-found for an unknown slug", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    await signUpViaApi(ctx);
    const res = await ctx.get(ENDPOINT(`definitely-not-real-${Date.now()}`));
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "not-found" });
    await ctx.dispose();
  });

  test("returns member when the user already belongs to the org", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    // Signup auto-creates an org and adds the user as a member — querying
    // their own slug should return "member" without any extra setup.
    const res = await ctx.get(ENDPOINT(user.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      organization: { slug: string };
    };
    expect(body.status).toBe("member");
    expect(body.organization.slug).toBe(user.orgSlug);
    await ctx.dispose();
  });

  test("returns pending-invite when an invitation matches the caller + org", async ({
    playwright,
  }) => {
    // User A creates org A.
    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);
    const orgARow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [userA.orgSlug],
    );
    const orgAId = orgARow.rows[0]?.id;
    if (!orgAId) throw new Error("Org A not found after signup");

    // User B exists but has no relationship to org A yet.
    const userBCtx = await newApiContext(playwright);
    const userB = await signUpViaApi(userBCtx);

    // A invites B by email.
    const inviteRes = await userACtx.post(
      "/api/auth/organization/invite-member",
      {
        data: { organizationId: orgAId, email: userB.email, role: "member" },
      },
    );
    expect(inviteRes.ok()).toBe(true);
    const invite = (await inviteRes.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = invite.id ?? invite.invitation?.id;
    expect(invitationId).toBeTruthy();

    // B queries org A — sees the pending invite.
    const res = await userBCtx.get(ENDPOINT(userA.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      invitation: { id: string };
      organization: { slug: string };
    };
    expect(body.status).toBe("pending-invite");
    expect(body.invitation.id).toBe(invitationId);
    expect(body.organization.slug).toBe(userA.orgSlug);

    await userACtx.dispose();
    await userBCtx.dispose();
  });

  test("ignores expired invitations and falls through to no-access", async ({
    playwright,
  }) => {
    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);
    const orgARow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [userA.orgSlug],
    );
    const orgAId = orgARow.rows[0]!.id;

    const userBCtx = await newApiContext(playwright);
    const userB = await signUpViaApi(userBCtx);

    const inviteRes = await userACtx.post(
      "/api/auth/organization/invite-member",
      {
        data: { organizationId: orgAId, email: userB.email, role: "member" },
      },
    );
    const invite = (await inviteRes.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = invite.id ?? invite.invitation?.id;

    // Mutate the invite to be expired. Better Auth's REST surface has no
    // "expire" verb, so SQL is the honest path here.
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.query(`UPDATE "invitation" SET "expiresAt" = $1 WHERE id = $2`, [
      past,
      invitationId,
    ]);

    const res = await userBCtx.get(ENDPOINT(userA.orgSlug));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("no-access");

    await userACtx.dispose();
    await userBCtx.dispose();
  });

  test("returns auto-domain-join when the org claims the caller's verified domain", async ({
    playwright,
  }) => {
    // Per-test domain so parallel workers don't fight over the same claim.
    const testDomain = `acme-status-${Date.now()}-${Math.floor(Math.random() * 100000)}.test`;

    // User A creates org A and claims `testDomain` with auto-join enabled.
    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);
    const orgARow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [userA.orgSlug],
    );
    const orgAId = orgARow.rows[0]!.id;
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO organization_domains
         (organization_id, domain, auto_join_enabled, created_at, updated_at)
       VALUES ($1, $2, true, $3, $3)`,
      [orgAId, testDomain, now],
    );

    // User B signs up with an email on `testDomain`. SignUpViaApi can't
    // pre-set emailVerified, so we flip it via SQL.
    const userBCtx = await newApiContext(playwright);
    const userB = await signUpViaApi(userBCtx, {
      email: `member-${Date.now()}@${testDomain}`,
    });
    await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
      userB.userId,
    ]);

    const res = await userBCtx.get(ENDPOINT(userA.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      organization: { slug: string; domain?: string };
    };
    expect(body.status).toBe("auto-domain-join");
    expect(body.organization.slug).toBe(userA.orgSlug);
    expect(body.organization.domain).toBe(testDomain);

    await userACtx.dispose();
    await userBCtx.dispose();
  });

  test("does NOT auto-domain-join when auto_join_enabled is false", async ({
    playwright,
  }) => {
    const testDomain = `acme-disabled-${Date.now()}-${Math.floor(Math.random() * 100000)}.test`;

    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);
    const orgAId = (
      await db.query<{ id: string }>(
        `SELECT id FROM "organization" WHERE slug = $1`,
        [userA.orgSlug],
      )
    ).rows[0]!.id;
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO organization_domains
         (organization_id, domain, auto_join_enabled, created_at, updated_at)
       VALUES ($1, $2, false, $3, $3)`,
      [orgAId, testDomain, now],
    );

    const userBCtx = await newApiContext(playwright);
    const userB = await signUpViaApi(userBCtx, {
      email: `member-${Date.now()}@${testDomain}`,
    });
    await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
      userB.userId,
    ]);

    const res = await userBCtx.get(ENDPOINT(userA.orgSlug));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("no-access");

    await userACtx.dispose();
    await userBCtx.dispose();
  });

  test("does NOT auto-domain-join for unverified email even if domain matches", async ({
    playwright,
  }) => {
    const testDomain = `acme-unverified-${Date.now()}-${Math.floor(Math.random() * 100000)}.test`;

    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);
    const orgAId = (
      await db.query<{ id: string }>(
        `SELECT id FROM "organization" WHERE slug = $1`,
        [userA.orgSlug],
      )
    ).rows[0]!.id;
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO organization_domains
         (organization_id, domain, auto_join_enabled, created_at, updated_at)
       VALUES ($1, $2, true, $3, $3)`,
      [orgAId, testDomain, now],
    );

    // User B signs up but emailVerified stays false (the signup default).
    const userBCtx = await newApiContext(playwright);
    await signUpViaApi(userBCtx, {
      email: `member-${Date.now()}@${testDomain}`,
    });

    const res = await userBCtx.get(ENDPOINT(userA.orgSlug));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("no-access");

    await userACtx.dispose();
    await userBCtx.dispose();
  });

  test("returns no-access when neither member nor invited nor auto-join-eligible", async ({
    playwright,
  }) => {
    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);

    const userBCtx = await newApiContext(playwright);
    await signUpViaApi(userBCtx);

    // B has no invite, no domain claim, isn't a member — should be "no-access".
    const res = await userBCtx.get(ENDPOINT(userA.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      organization: { slug: string };
    };
    expect(body.status).toBe("no-access");
    expect(body.organization.slug).toBe(userA.orgSlug);

    await userACtx.dispose();
    await userBCtx.dispose();
  });
});
