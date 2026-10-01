/**
 * E2E: removing a member revokes the access they held in that organization.
 *
 * An API key is authorized by its own stored allowlist, not by its owner's
 * role. Without a membership check, a key minted by a member keeps working
 * after the member is removed. Both removal paths are covered: the
 * ORGANIZATION_MEMBER_REMOVE tool and the web UI's direct Better Auth call
 * (`POST /api/auth/organization/remove-member`). The key is probed on the
 * org-scoped routes and on the legacy unscoped `/mcp/self` route, which takes
 * its org from the key's metadata instead of the path. Removal also deletes
 * the member's keys for the org and their org SSO session.
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { Client } from "pg";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const MCP_HEADERS = { Accept: "application/json, text/event-stream" };

const automationList = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name: "AUTOMATION_LIST", arguments: {} },
};

type RemovalPath = "tool" | "better-auth";

async function removeMember(
  path: RemovalPath,
  ownerCtx: APIRequestContext,
  orgSlug: string,
  orgId: string,
  memberEmail: string,
): Promise<void> {
  if (path === "tool") {
    await callSelfMcpTool(ownerCtx, orgSlug, "ORGANIZATION_MEMBER_REMOVE", {
      memberIdOrEmail: memberEmail,
    });
    return;
  }
  const res = await ownerCtx.post("/api/auth/organization/remove-member", {
    data: { organizationId: orgId, memberIdOrEmail: memberEmail },
  });
  expect(
    res.ok(),
    `remove-member: HTTP ${res.status()} — ${await res.text().catch(() => "")}`,
  ).toBe(true);
}

/** Every route a bearer could use to call AUTOMATION_LIST in `orgSlug`. */
async function probe(
  ctx: APIRequestContext,
  orgSlug: string,
  bearer: string,
): Promise<Record<string, boolean>> {
  const headers = { Authorization: `Bearer ${bearer}` };
  const rest = await ctx.post(`/api/${orgSlug}/tools/AUTOMATION_LIST`, {
    headers,
    data: {},
  });
  const scoped = await ctx.post(`/api/${orgSlug}/mcp/self`, {
    headers: { ...headers, ...MCP_HEADERS },
    data: automationList,
  });
  const legacy = await ctx.post("/mcp/self", {
    headers: { ...headers, ...MCP_HEADERS },
    data: automationList,
  });
  const rpcOk = async (res: APIResponse) => {
    if (!res.ok()) return false;
    const body = (await res.json().catch(() => null)) as {
      result?: { isError?: boolean };
    } | null;
    return !!body?.result && body.result.isError !== true;
  };
  return {
    "POST /api/:org/tools": rest.ok(),
    "POST /api/:org/mcp/self": await rpcOk(scoped),
    "POST /mcp/self (legacy)": await rpcOk(legacy),
  };
}

test.describe("member removal revokes access", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("the org's _self connection keeps working after its creator is removed", async ({
    playwright,
  }) => {
    const creatorCtx = await newApiContext(playwright);
    const creator = await signUpViaApi(creatorCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [creator.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org not found after signup");

    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const invite = await creatorCtx.post(
      "/api/auth/organization/invite-member",
      { data: { organizationId: orgId, email: owner.email, role: "owner" } },
    );
    expect(invite.ok(), await invite.text()).toBe(true);
    const inviteBody = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const accept = await ownerCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId: inviteBody.id ?? inviteBody.invitation?.id } },
    );
    expect(accept.ok(), await accept.text()).toBe(true);

    // An agent over the `_self` connection reaches it through an outbound
    // client that authenticates with the key minted for the creator.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      creator.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "self connection agent",
          status: "active",
          connections: [{ connection_id: `${orgId}_self` }],
        },
      },
    );
    const agentUrl = `/api/${creator.orgSlug}/mcp/virtual-mcp/${agent.item.id}`;
    const rpc = async (method: string, params: unknown) => {
      const res = await ownerCtx.post(agentUrl, {
        headers: MCP_HEADERS,
        data: { jsonrpc: "2.0", id: 1, method, params },
      });
      expect(res.ok(), `${method}: HTTP ${res.status()}`).toBe(true);
      return (await res.json()) as {
        result?: {
          isError?: boolean;
          tools?: Array<{ name: string }>;
          content?: Array<{ text?: string }>;
        };
        error?: { message?: string };
      };
    };
    const listed = await rpc("tools/list", {});
    const toolName = listed.result?.tools?.find((t) =>
      t.name.endsWith("AUTOMATION_LIST"),
    )?.name;
    expect(toolName, JSON.stringify(listed).slice(0, 500)).toBeTruthy();
    const callTool = () => rpc("tools/call", { name: toolName, arguments: {} });

    const before = await callTool();
    expect(before.result?.isError, JSON.stringify(before)).not.toBe(true);

    await callSelfMcpTool(
      ownerCtx,
      creator.orgSlug,
      "ORGANIZATION_MEMBER_REMOVE",
      {
        memberIdOrEmail: creator.email,
      },
    );

    const after = await callTool();
    expect(after.result?.isError, JSON.stringify(after)).not.toBe(true);
    expect(after.error).toBeUndefined();

    await creatorCtx.dispose();
    await ownerCtx.dispose();
  });

  for (const path of ["tool", "better-auth"] as const) {
    test(`removal via ${path}: the member's API key and OAuth token stop working`, async ({
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

      // An admin can mint keys; the built-in `user` role cannot.
      const memberCtx = await newApiContext(playwright);
      const member = await signUpViaApi(memberCtx);
      const invite = await ownerCtx.post(
        "/api/auth/organization/invite-member",
        { data: { organizationId: orgId, email: member.email, role: "admin" } },
      );
      expect(invite.ok(), await invite.text()).toBe(true);
      const inviteBody = (await invite.json()) as {
        id?: string;
        invitation?: { id?: string };
      };
      const invitationId = inviteBody.id ?? inviteBody.invitation?.id;
      const accept = await memberCtx.post(
        "/api/auth/organization/accept-invitation",
        { data: { invitationId } },
      );
      expect(accept.ok(), await accept.text()).toBe(true);

      const created = await callSelfMcpTool<{ id: string; key: string }>(
        memberCtx,
        owner.orgSlug,
        "API_KEY_CREATE",
        {
          name: `member-key-${Date.now()}`,
          permissions: { self: ["AUTOMATION_LIST"] },
        },
      );
      const { accessToken } = await mintMcpAccessToken(memberCtx);

      const apiCtx = await newApiContext(playwright);
      const allGranted = {
        "POST /api/:org/tools": true,
        "POST /api/:org/mcp/self": true,
        "POST /mcp/self (legacy)": true,
      };
      expect(await probe(apiCtx, owner.orgSlug, created.key)).toEqual(
        allGranted,
      );

      // Org SSO sessions have no API that works without an IdP; seed one.
      await db.query(
        `INSERT INTO org_sso_sessions
           (id, user_id, organization_id, authenticated_at, expires_at, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, now(), now() + interval '1 day', now())`,
        [member.userId, orgId],
      );

      await removeMember(path, ownerCtx, owner.orgSlug, orgId, member.email);

      const keyRows = await db.query(`SELECT 1 FROM apikey WHERE id = $1`, [
        created.id,
      ]);
      expect(keyRows.rowCount, "API key row after removal").toBe(0);
      const ssoRows = await db.query(
        `SELECT 1 FROM org_sso_sessions WHERE user_id = $1 AND organization_id = $2`,
        [member.userId, orgId],
      );
      expect(ssoRows.rowCount, "org SSO session after removal").toBe(0);

      const allDenied = {
        "POST /api/:org/tools": false,
        "POST /api/:org/mcp/self": false,
        "POST /mcp/self (legacy)": false,
      };
      expect(
        await probe(apiCtx, owner.orgSlug, created.key),
        "API key after removal",
      ).toEqual(allDenied);
      // An OAuth token is not bound to one org, and on the legacy route it
      // resolves to the user's only remaining membership (their own org), so
      // only the org-scoped routes say anything about the removed org.
      const oauth = await probe(apiCtx, owner.orgSlug, accessToken);
      expect(
        {
          "POST /api/:org/tools": oauth["POST /api/:org/tools"],
          "POST /api/:org/mcp/self": oauth["POST /api/:org/mcp/self"],
        },
        "MCP OAuth token after removal",
      ).toEqual({
        "POST /api/:org/tools": false,
        "POST /api/:org/mcp/self": false,
      });

      await ownerCtx.dispose();
      await memberCtx.dispose();
      await apiCtx.dispose();
    });
  }
});
