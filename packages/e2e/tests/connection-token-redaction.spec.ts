/**
 * E2E: connection tools never return a stored connection_token.
 *
 * Any member may list and get connections, and a token often grants more than
 * the member holds: the org's `_self` connection carries a `self: ["*"]`
 * management key. A built-in `user` member must see only that a token is set,
 * and echoing a fetched entity back through UPDATE must keep the stored token.
 */

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const REDACTED = "[redacted]";

interface ConnectionItem {
  id: string;
  title: string;
  connection_token: string | null;
}

test.describe("connection token redaction", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a user-role member cannot read connection tokens", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await findOrgId(ownerCtx, owner.orgSlug);
    const selfId = `${orgId}_self`;

    // The org's default connections are seeded after signup returns.
    await expect
      .poll(async () => {
        const row = await db.query<{ connection_token: string | null }>(
          `SELECT connection_token FROM connections WHERE id = $1`,
          [selfId],
        );
        return !!row.rows[0]?.connection_token;
      })
      .toBe(true);

    const secret = `e2e-secret-${randomUUID()}`;
    const created = await callSelfMcpTool<{ item: ConnectionItem }>(
      ownerCtx,
      owner.orgSlug,
      "COLLECTION_CONNECTIONS_CREATE",
      {
        data: {
          title: "token probe",
          connection_type: "HTTP",
          connection_url: "https://example.invalid/mcp",
          connection_token: secret,
        },
      },
    );
    expect(created.item.connection_token).toBe(REDACTED);

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
    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      {
        data: { invitationId: inviteJson.id ?? inviteJson.invitation?.id },
      },
    );
    expect(accept.ok()).toBe(true);

    const listRes = await memberCtx.post(`/api/${owner.orgSlug}/mcp/self`, {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
      },
      headers: { Accept: "application/json, text/event-stream" },
    });
    expect(listRes.ok()).toBe(true);
    // Assert on the bytes the member receives, not a parsed subset.
    expect(await listRes.text()).not.toContain(secret);

    const list = await callSelfMcpTool<{ items: ConnectionItem[] }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_CONNECTIONS_LIST",
      {},
    );
    const tokenFor = (id: string) =>
      list.items.find((item) => item.id === id)?.connection_token;
    expect(tokenFor(selfId)).toBe(REDACTED);
    expect(tokenFor(created.item.id)).toBe(REDACTED);
    for (const item of list.items) {
      expect([null, REDACTED]).toContain(item.connection_token);
    }

    const got = await callSelfMcpTool<{ item: ConnectionItem }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_CONNECTIONS_GET",
      { id: selfId },
    );
    expect(got.item.connection_token).toBe(REDACTED);

    // Echoing the fetched entity back must not overwrite the stored token.
    const storedToken = async () =>
      (
        await db.query<{ connection_token: string | null }>(
          `SELECT connection_token FROM connections WHERE id = $1`,
          [created.item.id],
        )
      ).rows[0]?.connection_token;
    const before = await storedToken();
    const updated = await callSelfMcpTool<{ item: ConnectionItem }>(
      memberCtx,
      owner.orgSlug,
      "COLLECTION_CONNECTIONS_UPDATE",
      {
        id: created.item.id,
        data: { title: "token probe renamed", connection_token: REDACTED },
      },
    );
    expect(updated.item.title).toBe("token probe renamed");
    expect(updated.item.connection_token).toBe(REDACTED);
    expect(await storedToken()).toBe(before);

    await expect(
      callSelfMcpTool(
        memberCtx,
        owner.orgSlug,
        "COLLECTION_CONNECTIONS_CREATE",
        {
          data: {
            title: "placeholder copy",
            connection_type: "HTTP",
            connection_url: "https://example.invalid/mcp",
            connection_token: REDACTED,
          },
        },
      ),
    ).rejects.toThrow(/redacted/);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
