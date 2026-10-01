import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { connectDevDb } from "../fixtures/db";

for (const scenario of [
  "no-flag",
  "legacy-enabled",
  "legacy-disabled",
  "other-user",
  "other-branch",
] as const) {
  test(`project checkout lookup: ${scenario}`, async ({ authedPage }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const { id: orgId } = await callSelfMcpTool<{ id: string }>(
      api,
      orgSlug,
      "ORGANIZATION_GET",
      {},
    );
    if (scenario === "legacy-enabled" || scenario === "legacy-disabled")
      await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
        organizationId: orgId,
        flags: {},
      });
    const { item: connection } = await callSelfMcpTool<{
      item: { id: string };
    }>(api, orgSlug, "COLLECTION_CONNECTIONS_CREATE", {
      data: {
        title: "Synthetic repository",
        app_name: "mcp-github",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        metadata: {
          repoScope: {
            sourceConnectionId: "synthetic-source",
            installationId: 1,
            owner: "example-owner",
            repo: "site",
            permissions: { contents: "write" },
          },
        },
      },
    });
    const { item: agent } = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Synthetic site",
          status: "active",
          pinned: false,
          connections: [],
          metadata: {
            repository: {
              owner: "example-owner",
              name: "site",
              url: "https://github.com/example-owner/site",
              connectionId: connection.id,
            },
          },
        },
      },
    );
    const seedDb = await connectDevDb();
    try {
      if (scenario === "legacy-enabled" || scenario === "legacy-disabled") {
        // The retired flag cannot be written through the current API schema.
        const updated = await seedDb.query(
          `UPDATE organization_settings SET flags = COALESCE(flags, '{}'::jsonb) || $1::jsonb WHERE "organizationId" = $2`,
          [
            JSON.stringify({
              coding_agent_project_context: scenario === "legacy-enabled",
            }),
            orgId,
          ],
        );
        expect(updated.rowCount).toBe(1);
      }
      // Sandbox records have no client-write API; lifecycle owns this metadata.
      await seedDb.query(
        "UPDATE connections SET metadata = (COALESCE(metadata, '{}')::jsonb || $1::jsonb)::text WHERE id = $2 AND organization_id = $3",
        [
          JSON.stringify({
            sandboxMap: {
              [scenario === "other-user" ? "user_other" : user.userId]: {
                [scenario === "other-branch"
                  ? "feature/other"
                  : "feature/preview"]: {
                  "agent-sandbox": {
                    sandboxHandle: "synthetic-existing-checkout",
                    previewUrl: null,
                  },
                },
              },
            },
          }),
          agent.id,
          orgId,
        ],
      );
    } finally {
      await seedDb.end();
    }
    const { item: thread } = await callSelfMcpTool<{
      item: { id: string; metadata: Record<string, unknown> };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: agent.id, branch: "feature/preview" },
    });
    const response = await api.post(
      `/api/${orgSlug}/mcp/task-run/${thread.id}`,
      {
        headers: { Accept: "application/json, text/event-stream" },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "TASK_ADD_REPO", arguments: { id: connection.id } },
        },
      },
    );
    expect(response.status()).toBe(200);
    const envelope = await response.json();
    if (scenario === "other-user" || scenario === "other-branch") {
      expect(envelope.result?.isError).toBe(true);
      expect(envelope.result.content[0].text).toContain(
        "No sandbox is registered",
      );
      return;
    }
    // The lookup found the record; with no live sandbox behind the synthetic
    // handle, the call can only fail later, at the checkout probe.
    expect(JSON.stringify(envelope)).not.toContain("No sandbox is registered");
    expect(JSON.stringify(envelope)).not.toContain("already checked out");
    const db = await connectDevDb();
    try {
      const stored = await db.query(
        "SELECT metadata FROM threads WHERE id = $1 AND organization_id = $2",
        [thread.id, orgId],
      );
      expect(stored.rows[0].metadata).toEqual(thread.metadata);
    } finally {
      await db.end();
    }
  });
}
