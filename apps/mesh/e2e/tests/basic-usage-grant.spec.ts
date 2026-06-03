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
 *     tool, yet is denied tools it was never granted — including agents:manage
 *     and connections:manage tools, which only the built-in user role gets. This
 *     is the test that actually exercises the runtime grant.
 *   - A member on the built-in "user" role gets basic-usage AND agents:manage +
 *     connections:manage (USER_ROLE_CAPABILITY_IDS) — so it can create an agent
 *     and a connection — but is still denied other gated tools and org
 *     management via Better Auth's native endpoints (invite-member). Guards two
 *     regressions: the `self: ["*"]` grant + wildcard fallback re-granting every
 *     tool, and the `user` role spreading `adminAc` (org-admin statements)
 *     instead of member-level `memberAc`.
 *   - A NON-member cannot call a basic-usage tool against the org — the grant
 *     must never leak past membership.
 *
 * Tool choices (denials use all-optional input schemas, or valid `data`, so a
 * denial surfaces as an access error rather than a schema-validation error):
 *   - AUTOMATION_LIST               → basic-usage
 *   - MONITORING_STATS              → NOT basic-usage (monitoring:view)
 *   - COLLECTION_VIRTUAL_MCP_CREATE → agents:manage (built-in user role only)
 *   - COLLECTION_CONNECTIONS_CREATE → connections:manage (built-in user role
 *     only). Sent with valid `data`; an unreachable URL is swallowed server-side
 *     so the user's create still succeeds.
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

// COLLECTION_VIRTUAL_MCP_CREATE (agents:manage) with VALID minimal data, so a
// denial is an access error rather than input validation. `title` + an (empty)
// `connections` array are the only required fields.
const agentCreateBody = () => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: {
    name: "COLLECTION_VIRTUAL_MCP_CREATE",
    arguments: { data: { title: "gating probe", connections: [] } },
  },
});

// COLLECTION_CONNECTIONS_CREATE (connections:manage) with VALID minimal data, so
// a denial is an access error rather than input validation. The handler swallows
// an unreachable URL (fetchToolsFromMCP().catch(() => null)), so a granted call
// still creates the row.
const connectionCreateBody = () => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: {
    name: "COLLECTION_CONNECTIONS_CREATE",
    arguments: {
      data: {
        title: "gating probe conn",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
      },
    },
  },
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

    // A custom role with NO permissions — fully restrictive (not owner/admin,
    // grants no tools). Better Auth's create-role only lets a creator grant
    // permissions they hold *explicitly*, and the owner's `self: ["*"]` is not
    // expanded for that check — so an empty permission is both what this test
    // needs (the role must not grant the tool under test) and what create-role
    // will accept.
    const roleSlug = `restricted-${Date.now()}-${Math.floor(
      Math.random() * 1e6,
    )}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      {
        data: {
          organizationId: orgId,
          role: roleSlug,
          permission: {},
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

    // Invite with the built-in "user" role (defined in our auth config); the
    // member's effective role is overwritten with the restrictive custom role
    // below, so this is only the transient role between invite and assignment.
    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgId, email: member.email, role: "user" },
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

    // agents:manage is NOT basic-usage and is NOT granted to this custom role,
    // so creating an agent is denied. (The built-in user role IS granted
    // agents:manage — see the next test — proving this is role-specific.)
    const agentRes = await memberCtx.post(`/api/${owner.orgSlug}/mcp/self`, {
      data: agentCreateBody(),
      headers: MCP_HEADERS,
    });
    const agentDenied = (await agentRes.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    const agentErr =
      agentDenied.result?.content?.[0]?.text ??
      agentDenied.error?.message ??
      "";
    expect(
      agentDenied.result?.isError === true || !!agentDenied.error,
      `expected COLLECTION_VIRTUAL_MCP_CREATE to be denied for the custom role, got: ${JSON.stringify(
        agentDenied,
      )}`,
    ).toBe(true);
    expect(agentErr).toMatch(/access denied|permission/i);

    // connections:manage is likewise NOT granted to this custom role → denied.
    const connRes = await memberCtx.post(`/api/${owner.orgSlug}/mcp/self`, {
      data: connectionCreateBody(),
      headers: MCP_HEADERS,
    });
    const connDenied = (await connRes.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    const connErr =
      connDenied.result?.content?.[0]?.text ?? connDenied.error?.message ?? "";
    expect(
      connDenied.result?.isError === true || !!connDenied.error,
      `expected COLLECTION_CONNECTIONS_CREATE to be denied for the custom role, got: ${JSON.stringify(
        connDenied,
      )}`,
    ).toBe(true);
    expect(connErr).toMatch(/access denied|permission/i);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("the built-in user role gets basic-usage but is denied gated tools", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org not found after signup");

    // A second user, invited and LEFT on the built-in "user" role (no custom
    // role reassignment). This is the path that regressed: the `user` role is
    // defined with `self: ["*"]`, and the runtime wildcard fallback would
    // otherwise grant it every tool once the owner/admin-only bypass is in
    // place. It must get basic-usage only.
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
    expect(invitationId).toBeTruthy();

    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId } },
    );
    expect(
      accept.ok(),
      `accept-invitation failed: ${await accept.text().catch(() => "")}`,
    ).toBe(true);

    // Basic-usage tool → granted at runtime regardless of role.
    const automations = await callSelfMcpTool<{ automations: unknown[] }>(
      memberCtx,
      owner.orgSlug,
      "AUTOMATION_LIST",
      {},
    );
    expect(Array.isArray(automations.automations)).toBe(true);

    // agents:manage IS granted to the built-in user role
    // (USER_ROLE_CAPABILITY_IDS) → creating an agent succeeds. callSelfMcpTool
    // throws on an access denial, so a returned item proves the grant.
    const created = await callSelfMcpTool<{ item: { id: string } }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "user-managed agent", connections: [] } },
    );
    expect(created.item?.id).toBeTruthy();

    // connections:manage IS granted to the built-in user role too → creating a
    // connection succeeds (the unreachable URL is swallowed server-side).
    const createdConn = await callSelfMcpTool<{ item: { id: string } }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_CONNECTIONS_CREATE",
      {
        data: {
          title: "user-managed conn",
          connection_type: "HTTP",
          connection_url: "https://example.com/mcp",
        },
      },
    );
    expect(createdConn.item?.id).toBeTruthy();

    // Gated tool (monitoring:view) → denied. Before enforcing the user role,
    // the `self: ["*"]` grant + wildcard fallback leaked full access here.
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
      `expected MONITORING_STATS to be denied for built-in user, got: ${JSON.stringify(
        denied,
      )}`,
    ).toBe(true);
    expect(errText).toMatch(/access denied|permission/i);

    // The built-in user role uses member-level org statements (memberAc), not
    // adminAc — so Better Auth's native org endpoints reject org management.
    // invite-member requires `invitation: ["create"]`, which memberAc omits;
    // adminAc would have granted it.
    const escalation = await memberCtx.post(
      "/api/auth/organization/invite-member",
      {
        data: {
          organizationId: orgId,
          email: `escalation-${Date.now()}@example.com`,
          role: "user",
        },
      },
    );
    expect(
      escalation.ok(),
      `expected invite-member to be denied for built-in user, got ${escalation.status()}: ${await escalation
        .text()
        .catch(() => "")}`,
    ).toBe(false);

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
