/**
 * E2E: chat title generation for the Codex harness. Mirrors
 * claude-code-title.spec.ts — see that file for the rationale.
 */
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const OPENAI_AVAILABLE = !!process.env.E2E_OPENAI_KEY;

test.describe("codex title generation", () => {
  test.skip(
    !OPENAI_AVAILABLE,
    "Requires E2E_OPENAI_KEY to be set; the harness spawns the codex app-server which needs a real model credential",
  );

  test("auto-titles a new thread after the first user message", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "codex title e2e",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{
        item: { id: string; title: string };
      }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
        data: { virtual_mcp_id: agent.item.id },
      });
      expect(thread.item.title).toBe("New chat");

      const runResp = await api.post(
        `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
        {
          data: {
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "Add OAuth login" }],
              },
            ],
            agent: { id: agent.item.id },
            branch: "ephemeral",
            temperature: 0.5,
            sandboxProviderKind: "cluster",
            harnessId: "codex",
          },
          headers: { "content-type": "application/json" },
        },
      );
      expect(runResp.status()).toBe(202);

      const deadline = Date.now() + 20_000;
      let observedTitle = "New chat";
      while (Date.now() < deadline) {
        const { rows } = await db.query(
          "SELECT title FROM threads WHERE id = $1",
          [thread.item.id],
        );
        observedTitle = (rows[0]?.title as string | undefined) ?? "New chat";
        if (observedTitle !== "New chat") break;
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(observedTitle).not.toBe("New chat");
      expect(observedTitle.length).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });
});
