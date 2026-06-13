/**
 * E2E: in-memory built-in-role permission resolution must grant/deny IDENTICALLY
 * to the Better Auth path it replaces.
 *
 * Flow 2 (browser sessions) used to make TWO DB-backed Better Auth
 * `hasPermission` calls per non-admin tool check. For BUILT-IN roles
 * (`user`/`admin`/`owner`) the role → statement mapping is static code, so the
 * check is now resolved in-memory (`auth/builtin-role-permission.ts`), with a
 * fall-back to the unchanged Better Auth path for custom / multi-role / unknown
 * roles.
 *
 * This spec exercises the REAL stack (Better Auth + resolveOrgFromPath + self
 * MCP) so a divergence between the in-memory matcher and Better Auth surfaces as
 * a failing grant/deny — the only honest way to assert parity. `basic-usage-grant.spec.ts`
 * covers the same boundary from the basic-usage angle; this one pins the
 * built-in `user` grant battery and the custom-role FALL-BACK path explicitly.
 *
 * Tool buckets for the built-in `user` role:
 *   GRANT  AUTOMATION_LIST                (basic-usage, runtime grant)
 *   GRANT  COLLECTION_VIRTUAL_MCP_CREATE  (agents:manage → user role self list)
 *   GRANT  COLLECTION_CONNECTIONS_CREATE  (connections:manage → user role self)
 *   DENY   MONITORING_STATS               (monitoring:view, not granted)
 *   DENY   AI_GENERATE_OBJECT? no — use a clearly gated mgmt tool:
 *   DENY   ORGANIZATION_MEMBER_ADD-style via native endpoint (covered elsewhere)
 *
 * All denials use a tool with an all-optional / empty-arg schema so a denial is
 * an access error, not a schema-validation error.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const MCP_HEADERS = { Accept: "application/json, text/event-stream" };

const toolCallBody = (name: string, args: unknown = {}) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

async function inviteAndAccept(
  ownerCtx: import("@playwright/test").APIRequestContext,
  memberCtx: import("@playwright/test").APIRequestContext,
  orgId: string,
  email: string,
): Promise<void> {
  const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
    data: { organizationId: orgId, email, role: "user" },
  });
  expect(
    invite.ok(),
    `invite failed: ${await invite.text().catch(() => "")}`,
  ).toBe(true);
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
    `accept failed: ${await accept.text().catch(() => "")}`,
  ).toBe(true);
}

/** Assert a self MCP tool call is denied with an access/permission error. */
async function expectDenied(
  ctx: import("@playwright/test").APIRequestContext,
  orgSlug: string,
  name: string,
  args: unknown = {},
): Promise<void> {
  const res = await ctx.post(`/api/${orgSlug}/mcp/self`, {
    data: toolCallBody(name, args),
    headers: MCP_HEADERS,
  });
  const body = (await res.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: { message?: string };
  };
  const errText = body.result?.content?.[0]?.text ?? body.error?.message ?? "";
  expect(
    body.result?.isError === true || !!body.error,
    `expected ${name} to be DENIED, got: ${JSON.stringify(body)}`,
  ).toBe(true);
  expect(errText).toMatch(/access denied|permission/i);
}

test.describe("member permission parity (in-memory built-in role resolution)", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("built-in user role: in-memory grants/denies match the documented role", async ({
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

    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);
    await inviteAndAccept(ownerCtx, memberCtx, orgId, member.email);

    // GRANT: basic-usage (runtime grant, never reaches the matcher) — sanity.
    const automations = await callSelfMcpTool<{ automations: unknown[] }>(
      memberCtx,
      owner.orgSlug,
      "AUTOMATION_LIST",
      {},
    );
    expect(Array.isArray(automations.automations)).toBe(true);

    // GRANT: agents:manage — in the built-in user role's `self` list, so the
    // in-memory matcher must resolve "grant" (not fall back, not deny).
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "parity agent", connections: [] } },
    );
    expect(agent.item?.id).toBeTruthy();

    // GRANT: connections:manage — also in the user role's `self` list.
    const conn = await callSelfMcpTool<{ item: { id: string } }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_CONNECTIONS_CREATE",
      {
        data: {
          title: "parity conn",
          connection_type: "HTTP",
          connection_url: "https://example.com/mcp",
        },
      },
    );
    expect(conn.item?.id).toBeTruthy();

    // DENY: a gated tool NOT in the user role's self list → in-memory "deny".
    // This is the case that would silently over-grant if the matcher were
    // wrong (e.g. mis-applied a wildcard).
    await expectDenied(memberCtx, owner.orgSlug, "MONITORING_STATS");

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("custom role falls back to Better Auth and is still enforced", async ({
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

    // Custom role granting exactly one tool on `self`. A built-in-role matcher
    // must NOT resolve this — it returns "fallback" and Better Auth enforces it.
    const roleSlug = `parity-custom-${Date.now()}-${Math.floor(
      Math.random() * 1e6,
    )}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      {
        data: {
          organizationId: orgId,
          role: roleSlug,
          permission: { self: ["MONITORING_STATS"] },
        },
      },
    );
    expect(
      createRole.ok(),
      `create-role failed: ${await createRole.text().catch(() => "")}`,
    ).toBe(true);

    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);
    await inviteAndAccept(ownerCtx, memberCtx, orgId, member.email);

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

    // GRANT via fall-back: the custom role explicitly lists MONITORING_STATS,
    // which the built-in `user` role does NOT — proving the fall-back path runs
    // the real Better Auth check (the matcher would have denied this tool).
    const stats = await callSelfMcpTool(
      memberCtx,
      owner.orgSlug,
      "MONITORING_STATS",
      {},
    );
    expect(stats).toBeDefined();

    // DENY via fall-back: a tool the custom role does NOT list. Better Auth
    // denies; basic-usage is still granted out-of-band, so pick a clearly gated
    // tool that is neither basic-usage nor in the custom role.
    await expectDenied(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "should be denied", connections: [] } },
    );

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
