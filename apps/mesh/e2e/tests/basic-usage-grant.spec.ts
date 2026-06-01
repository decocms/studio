/**
 * E2E: runtime basic-usage grant + its org-membership boundary.
 *
 * Basic-usage tools are granted at runtime by AccessControl (`checkResource`)
 * to every org member regardless of role, rather than being baked into each
 * role's stored permission. These specs verify that behavior through the real
 * stack (Better Auth + resolveOrgFromPath + the self MCP), which a unit test
 * mocking BoundAuthClient cannot honestly do:
 *
 *   - A member with a restrictive CUSTOM role (not owner/admin, and whose
 *     stored permission does NOT list the tool) can still call a basic-usage
 *     tool, yet is denied a non-basic tool it was never granted. This is the
 *     test that actually exercises the runtime grant.
 *   - A NON-member cannot call a basic-usage tool against the org — the grant
 *     must never leak past membership.
 *
 * Tool choices have all-optional input schemas, so a denial surfaces as an
 * access error rather than a schema-validation error:
 *   - AUTOMATION_LIST  → basic-usage
 *   - MONITORING_STATS → NOT basic-usage (monitoring:view capability)
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const MCP_HEADERS = { Accept: "application/json, text/event-stream" };

const toolCallBody = (name: string) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});

test.describe("runtime basic-usage grant", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a restrictive custom role still gets basic-usage tools, but not others", async ({
    playwright,
  }) => {
    // Owner of org A.
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org A not found after signup");

    // A custom role granting exactly one non-basic tool (ORGANIZATION_GET) and
    // nothing else — not owner/admin, and no basic-usage tools listed.
    const roleSlug = `restricted-${Date.now()}-${Math.floor(
      Math.random() * 1e6,
    )}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      {
        data: {
          organizationId: orgId,
          role: roleSlug,
          permission: { self: ["ORGANIZATION_GET"] },
        },
      },
    );
    expect(
      createRole.ok(),
      `create-role failed: ${await createRole.text().catch(() => "")}`,
    ).toBe(true);

    // A second user, invited into org A and assigned the custom role.
    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);

    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgId, email: member.email, role: "member" },
    });
    expect(invite.ok()).toBe(true);
    const inviteJson = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
    expect(invitationId).toBeTruthy();

    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId } },
    );
    expect(
      accept.ok(),
      `accept-invitation failed: ${await accept.text().catch(() => "")}`,
    ).toBe(true);

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

    // Basic-usage tool the role does NOT list → granted at runtime.
    const automations = await callSelfMcpTool<{ automations: unknown[] }>(
      memberCtx,
      owner.orgSlug,
      "AUTOMATION_LIST",
      {},
    );
    expect(Array.isArray(automations.automations)).toBe(true);

    // Non-basic tool the role does NOT list → denied. Access denial surfaces
    // as a tool-error envelope (isError) or a JSON-RPC error, not HTTP 403.
    const deniedRes = await memberCtx.post(`/api/${owner.orgSlug}/mcp/self`, {
      data: toolCallBody("MONITORING_STATS"),
      headers: MCP_HEADERS,
    });
    const denied = (await deniedRes.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    const errText =
      denied.result?.content?.[0]?.text ?? denied.error?.message ?? "";
    expect(
      denied.result?.isError === true || !!denied.error,
      `expected MONITORING_STATS to be denied, got: ${JSON.stringify(denied)}`,
    ).toBe(true);
    expect(errText).toMatch(/access denied|permission/i);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("a non-member cannot call a basic-usage tool against the org", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    // Outsider has their own org but no membership in the owner's org.
    const outsiderCtx = await newApiContext(playwright);
    await signUpViaApi(outsiderCtx);

    const res = await outsiderCtx.post(`/api/${owner.orgSlug}/mcp/self`, {
      data: toolCallBody("AUTOMATION_LIST"),
      headers: MCP_HEADERS,
    });
    // resolveOrgFromPath rejects non-members before AccessControl runs.
    expect(res.status()).toBe(403);

    await ownerCtx.dispose();
    await outsiderCtx.dispose();
  });
});
