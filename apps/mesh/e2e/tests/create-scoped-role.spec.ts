/**
 * E2E: an owner can create a capability-scoped custom role.
 *
 * Regression guard for a Better Auth dynamic-AC gotcha: create-role checks that
 * the creator *holds* every permission they grant, and access-control matches
 * actions literally — so a built-in owner defined as `self: ["*"]` was reported
 * as "missing self:SOME_TOOL" and couldn't create any tool-scoped role
 * (YOU_ARE_NOT_ALLOWED_TO_CREATE_A_ROLE). The built-in roles now enumerate the
 * full tool list, so an owner can grant any tool.
 *
 * The second test exercises the whole chain the role editor relies on:
 * create a scoped role → assign it to a member → that member's resolved
 * capabilities reflect exactly the granted tools.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

// The tools backing the monitoring:view capability (registry-metadata).
const MONITORING_TOOLS = [
  "MONITORING_LOG_GET",
  "MONITORING_LOGS_LIST",
  "MONITORING_STATS",
];

async function orgIdForSlug(db: Client, slug: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error(`org not found for slug ${slug}`);
  return id;
}

test.describe("create capability-scoped role", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("an owner can create a role granting specific tools", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    const res = await ctx.post("/api/auth/organization/create-role", {
      data: {
        organizationId: orgId,
        role: `monitor-${Date.now()}`,
        permission: { self: MONITORING_TOOLS },
      },
    });
    expect(
      res.ok(),
      `create-role failed: ${await res.text().catch(() => "")}`,
    ).toBe(true);

    await ctx.dispose();
  });

  test("a scoped role resolves to exactly its capabilities for a member", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    const roleSlug = `monitor-${Date.now()}`;
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

    // A member, invited and then assigned the scoped role.
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

    // The member's resolved capabilities reflect exactly the granted tools.
    const res = await memberCtx.get(
      `/api/auth/custom/my-capabilities/${encodeURIComponent(owner.orgSlug)}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      role: string | null;
      capabilities: Record<string, boolean>;
    };
    expect(body.role).toBe(roleSlug);
    expect(body.capabilities["monitoring:view"]).toBe(true);
    expect(body.capabilities["members:manage"]).toBe(false);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
