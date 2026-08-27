/**
 * `invitation."autoAccept"` is claimed at signup; a plain invitation is not.
 *
 * Guards the consent boundary: inviting an arbitrary address must not place
 * that person in an org the first time they sign up. Only bulk backfills of
 * memberships that already existed elsewhere set the flag.
 *
 * The org is seeded directly and no domain is claimed, so the only thing that
 * can produce a membership here is the invitation itself.
 */

import { type Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUp } from "../fixtures/auth";
import { expect, test } from "../fixtures/test";

const RUN = `${Date.now()}`;
const TEST_DOMAIN = `autoaccept-e2e-${RUN}.test`;
const ORG_ID = `e2e_autoaccept_org_${RUN}`;

const INVITER_ID = `e2e_autoaccept_inviter_${RUN}`;

async function seedInvitation(
  db: Client,
  email: string,
  autoAccept: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO invitation
       (id, "organizationId", email, role, status, "expiresAt", "inviterId",
        "createdAt", "autoAccept")
     VALUES (gen_random_uuid()::text, $1, $2, 'admin', 'pending',
             timestamptz '2099-12-31 23:59:59+00', $3, now(), $4)`,
    [ORG_ID, email, INVITER_ID, autoAccept],
  );
}

async function memberCount(db: Client, userId: string): Promise<string> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "member"
     WHERE "userId" = $1 AND "organizationId" = $2`,
    [userId, ORG_ID],
  );
  return result.rows[0]!.count;
}

test.describe("Invite: only an autoAccept invitation is claimed at signup", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
    await db.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, "AutoAccept E2E Org", `e2e-autoaccept-org-${RUN}`],
    );
  });

  test.afterAll(async () => {
    if (!db) return;
    await db.query(`DELETE FROM invitation WHERE "organizationId" = $1`, [
      ORG_ID,
    ]);
    await db.query(`DELETE FROM "member" WHERE "organizationId" = $1`, [
      ORG_ID,
    ]);
    await db.query(`DELETE FROM "organization" WHERE id = $1`, [ORG_ID]);
    await db.end();
  });

  test("autoAccept invitation places the user in the org with its role", async ({
    page,
  }) => {
    const email = `flagged-${RUN}-${Math.floor(Math.random() * 100000)}@${TEST_DOMAIN}`;
    await seedInvitation(db, email, true);
    await signUp(page, { email });

    const userRow = await db.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    const userId = userRow.rows[0]!.id;

    expect(await memberCount(db, userId)).toBe("1");

    const membership = await db.query<{ role: string | null }>(
      `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [userId, ORG_ID],
    );
    expect(membership.rows[0]!.role).toBe("admin");

    const invitation = await db.query<{ status: string }>(
      `SELECT status FROM invitation WHERE lower(email) = lower($1)`,
      [email],
    );
    expect(invitation.rows[0]!.status).toBe("accepted");
  });

  test("a plain invitation leaves the user out of the org until they accept", async ({
    page,
  }) => {
    const email = `plain-${RUN}-${Math.floor(Math.random() * 100000)}@${TEST_DOMAIN}`;
    await seedInvitation(db, email, false);
    await signUp(page, { email });

    const userRow = await db.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    const userId = userRow.rows[0]!.id;

    expect(await memberCount(db, userId)).toBe("0");

    const invitation = await db.query<{ status: string }>(
      `SELECT status FROM invitation WHERE lower(email) = lower($1)`,
      [email],
    );
    expect(invitation.rows[0]!.status).toBe("pending");
  });
});
