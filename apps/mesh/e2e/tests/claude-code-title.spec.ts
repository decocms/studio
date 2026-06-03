/**
 * E2E: chat title generation for the Claude Code harness.
 *
 * Posts a single user message to a new thread routed through the
 * claude-code harness via cluster dispatch, then polls the threads
 * table until the title changes from the default "New chat". The exact
 * title text is non-deterministic (LLM output), so we assert only that
 * it stopped being the default.
 *
 * Skipped automatically when E2E_ANTHROPIC_KEY is not set — the
 * cluster needs a real Anthropic credential to spawn the claude CLI.
 */
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const ANTHROPIC_AVAILABLE = !!process.env.E2E_ANTHROPIC_KEY;

test.describe("claude-code title generation", () => {
  test.skip(
    !ANTHROPIC_AVAILABLE,
    "Requires E2E_ANTHROPIC_KEY to be set; the harness spawns the claude CLI which needs a real model credential",
  );

  test("auto-titles a new thread after the first user message", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      // 1. Create agent + thread (default title = "New chat").
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "claude-code title e2e",
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

      // 2. POST one message pinned to the claude-code harness on cluster.
      const runResp = await api.post(
        `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
        {
          data: {
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "Fix the login on mobile" }],
              },
            ],
            agent: { id: agent.item.id },
            branch: "ephemeral",
            temperature: 0.5,
            sandboxProviderKind: "cluster",
            harnessId: "claude-code",
          },
          headers: { "content-type": "application/json" },
        },
      );
      expect(runResp.status()).toBe(202);

      // 3. Poll up to 20s for the title to change (10s grace + LLM latency).
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
