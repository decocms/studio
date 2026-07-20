/**
 * Domain auto-join must not duplicate an invited member.
 *
 * Repro of the reported bug: an owner invites teammates on the org's corporate
 * domain; each invitee signs up, gets domain-auto-joined at signup (member row
 * #1), then accepts the invitation, which unconditionally creates member row #2
 * — so they appear twice in the members list.
 *
 * The fix skips the domain auto-join when a pending invitation already governs
 * membership, so accepting the invitation is the single membership path. This
 * spec exercises `ensureUserOrganization` through its real HTTP surface
 * (POST /api/auth/custom/ensure-organization) with a pending invitation present
 * vs. removed, proving the invitation is what suppresses the auto-join.
 *
 * Like auto-domain-join-multi-org.spec.ts, the domain claim needs
 * emailVerified=true (an OTP flow we can't drive headlessly), so we seed the
 * org + verified domain directly and flip the signed-up user to verified.
 */

import { type Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUp } from "../fixtures/auth";
import { expect, test } from "../fixtures/test";

const TEST_DOMAIN = `invite-e2e-${Date.now()}.test`;
const ORG_SLUG = `e2e-invite-org-${Date.now()}`;
const ORG_ID = `e2e_invite_org_${Date.now()}`;

test.describe("Invite: domain auto-join does not duplicate the member", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, "Invite E2E Org", ORG_SLUG, now],
    );

    await db.query(
      `INSERT INTO organization_domains
         (id, organization_id, domain, join_mode, verification_status,
          verification_method, verified_at, created_at, updated_at)
       VALUES
         (gen_random_uuid()::text, $1, $2, 'auto', 'verified', 'email', $3, $3, $3)
       ON CONFLICT (organization_id, domain) DO UPDATE
         SET join_mode = EXCLUDED.join_mode,
             verification_status = EXCLUDED.verification_status,
             updated_at = EXCLUDED.updated_at`,
      [ORG_ID, TEST_DOMAIN, now],
    );
  });

  test.afterAll(async () => {
    if (!db) return;
    await db.query(`DELETE FROM invitation WHERE "organizationId" = $1`, [
      ORG_ID,
    ]);
    await db.query(`DELETE FROM organization_domains WHERE domain = $1`, [
      TEST_DOMAIN,
    ]);
    await db.query(`DELETE FROM "member" WHERE "organizationId" = $1`, [
      ORG_ID,
    ]);
    await db.query(`DELETE FROM "organization" WHERE id = $1`, [ORG_ID]);
    await db.end();
  });

  test("skips auto-join while an invitation is pending, joins once it is gone", async ({
    page,
  }) => {
    const suffix = Date.now() + Math.floor(Math.random() * 100000);
    const email = `invitee-${suffix}@${TEST_DOMAIN}`;
    await signUp(page, { email });

    const userRow = await db.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    const userId = userRow.rows[0]?.id;
    if (!userId) throw new Error(`Test user ${email} not found after signup`);

    // /ensure-organization only domain-joins verified corporate users, and the
    // user must not already belong to an org (signup auto-creates one).
    await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
      userId,
    ]);
    await db.query(`DELETE FROM "member" WHERE "userId" = $1`, [userId]);

    // A pending invitation to the same org, addressed to this user.
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO invitation
         (id, "organizationId", email, role, status, "expiresAt", "inviterId", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'user', 'pending', $3, $4, $5)`,
      [ORG_ID, email, expiresAt, userId, now],
    );

    // With the invitation pending, the auto-join must be skipped.
    const skipped = await page.request.post(
      "/api/auth/custom/ensure-organization",
    );
    const skippedBody = await skipped.json();
    expect(skippedBody.status).toBe("skipped");
    expect(skippedBody.reason).toBe("pending-invitation");

    const afterSkip = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "member"
       WHERE "userId" = $1 AND "organizationId" = $2`,
      [userId, ORG_ID],
    );
    expect(afterSkip.rows[0]!.count).toBe("0");

    // Remove the invitation (as accepting it would) and re-run: now the domain
    // auto-join proceeds, producing exactly one membership — never two.
    await db.query(`DELETE FROM invitation WHERE "organizationId" = $1`, [
      ORG_ID,
    ]);

    const joined = await page.request.post(
      "/api/auth/custom/ensure-organization",
    );
    const joinedBody = await joined.json();
    expect(joinedBody.success).toBe(true);

    const afterJoin = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "member"
       WHERE "userId" = $1 AND "organizationId" = $2`,
      [userId, ORG_ID],
    );
    expect(afterJoin.rows[0]!.count).toBe("1");
  });
});
