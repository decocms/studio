/**
 * E2E: REST tool-dispatch endpoint (`POST /api/:org/tools/:name`).
 *
 * The web client now calls builtin tools over plain REST instead of MCP. This
 * verifies the REST front-door enforces the SAME authorization as the legacy
 * `/mcp/self` path (see basic-usage-grant.spec.ts) — but surfaces it as proper
 * HTTP status codes instead of MCP `isError` envelopes:
 *   - a member on a restrictive custom role still gets a basic-usage tool
 *     (AUTOMATION_LIST → 200, runtime grant), and
 *   - is denied a gated tool (MONITORING_STATS → 403).
 *   - unknown tool names → 404 (the manual identifier check).
 *   - non-members are rejected before the tool runs (resolveOrgFromPath).
 */
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("REST tool dispatch", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("enforces the same authz as /mcp/self, with HTTP status codes", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    // Owner (full access): a builtin tool over REST returns 200 + the raw result.
    const ok = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/AUTOMATION_LIST`,
      {
        data: {},
      },
    );
    expect(
      ok.ok(),
      `AUTOMATION_LIST: HTTP ${ok.status()} — ${await ok.text().catch(() => "")}`,
    ).toBe(true);
    const okBody = (await ok.json()) as { automations?: unknown[] };
    expect(Array.isArray(okBody.automations)).toBe(true);

    // Unknown tool → 404 (manual identifier check).
    const notFound = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/NOPE_NOT_A_REAL_TOOL`,
      { data: {} },
    );
    expect(notFound.status()).toBe(404);

    // --- restrictive custom-role member ---
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org not found after signup");

    const roleSlug = `restricted-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      { data: { organizationId: orgId, role: roleSlug, permission: {} } },
    );
    expect(createRole.ok()).toBe(true);

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
    expect(assign.ok()).toBe(true);

    // Basic-usage tool the role does NOT list → granted at runtime → 200.
    const memberOk = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/AUTOMATION_LIST`,
      { data: {} },
    );
    expect(
      memberOk.ok(),
      `member AUTOMATION_LIST: HTTP ${memberOk.status()}`,
    ).toBe(true);

    // Gated tool (monitoring:view) NOT granted → 403 with a permission message.
    const denied = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { data: {} },
    );
    expect(denied.status()).toBe(403);
    const deniedBody = (await denied.json()) as { error?: string };
    expect(deniedBody.error ?? "").toMatch(
      /access denied|permission|forbidden/i,
    );

    // Non-member is rejected by resolveOrgFromPath before the tool runs.
    const strangerCtx = await newApiContext(playwright);
    await signUpViaApi(strangerCtx);
    const stranger = await strangerCtx.post(
      `/api/${owner.orgSlug}/tools/AUTOMATION_LIST`,
      { data: {} },
    );
    expect([403, 404]).toContain(stranger.status());

    await ownerCtx.dispose();
    await memberCtx.dispose();
    await strangerCtx.dispose();
  });
});
