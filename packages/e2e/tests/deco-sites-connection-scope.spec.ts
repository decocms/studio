/**
 * E2E: POST /api/:org/deco-sites/connection must enforce the same
 * COLLECTION_CONNECTIONS_CREATE permission as the normal connection-create
 * tool. This route writes a connection row directly instead of going through
 * that tool's handler, so it previously had no permission check of its own —
 * a member on a custom role with connections:create revoked could still
 * create a connection through this deco.cx import flow.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

// Scoped role with no connection-management tool granted.
const MONITORING_TOOLS = ["MONITORING_STATS"];

async function orgIdForSlug(db: Client, slug: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error(`org not found for slug ${slug}`);
  return id;
}

test.describe("deco-sites connection create — permission scope", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a member without connections:create is denied", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    const roleSlug = `no-connections-${Date.now()}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      {
        data: {
          organizationId: orgId,
          role: roleSlug,
          permission: { self: MONITORING_TOOLS },
        },
      },
    );
    expect(
      createRole.ok(),
      `create-role failed: ${await createRole.text().catch(() => "")}`,
    ).toBe(true);

    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);

    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgId, email: member.email, role: "user" },
    });
    expect(invite.ok()).toBe(true);
    const inviteJson = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = inviteJson.id ?? inviteJson.invitation?.id;

    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId } },
    );
    expect(accept.ok()).toBe(true);

    const memberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [member.userId, orgId],
    );
    const memberId = memberRow.rows[0]?.id;
    if (!memberId) throw new Error("member row not found after accept");

    const assign = await ownerCtx.post(
      "/api/auth/organization/update-member-role",
      { data: { organizationId: orgId, memberId, role: [roleSlug] } },
    );
    expect(
      assign.ok(),
      `update-member-role failed: ${await assign.text().catch(() => "")}`,
    ).toBe(true);

    const res = await memberCtx.post(
      `/api/${encodeURIComponent(owner.orgSlug)}/deco-sites/connection`,
      { data: { siteName: "some-site" } },
    );
    expect(res.status()).toBe(403);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
