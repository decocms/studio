/**
 * E2E: stop a running hosted (decopilot) turn, then send a follow-up on the
 * SAME thread — the follow-up must run to completion, not hang forever.
 *
 * Repro for the reported "stop a thread and then ask a follow up: it never
 * returns" bug. Unlike the queue specs (which use the claude-code + fake
 * tunnel-daemon path), this drives the REAL hosted decopilot agent loop
 * against a real openai-compatible provider, because the bug only reproduces
 * on the hosted topology (agent-sandbox + decopilot), which no other e2e
 * exercises.
 *
 * Requires OPENROUTER_API_KEY in the environment; skipped otherwise. The key
 * is written into an org-scoped `AI_PROVIDER_KEY_CREATE` credential (never
 * hardcoded) pointing at OpenRouter's openai-compatible endpoint, pinned to
 * the "smart" tier.
 */
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import type { APIRequestContext } from "@playwright/test";

type Db = Awaited<ReturnType<typeof connectDevDb>>;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// A cheap, always-available OpenRouter model.
const MODEL_ID = process.env.E2E_OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM organization WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`org not found for slug ${slug}`);
  return id;
}

async function fetchThreadStatus(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.status ?? null;
}

async function assistantTextCount(db: Db, threadId: string): Promise<number> {
  // v2 stream-of-record: assistant text lands as `text` parts.
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM thread_message_parts
       WHERE thread_id = $1 AND kind = 'text'`,
    [threadId],
  );
  return Number(rows[0]?.n ?? "0");
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
  text: string,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: {
      messages: [{ role: "user", parts: [{ type: "text", text }] }],
      branch: "ephemeral",
      temperature: 0,
    },
    headers: { "content-type": "application/json" },
  });
}

test.describe("decopilot hosted — stop then follow-up", () => {
  test.skip(!OPENROUTER_API_KEY, "requires OPENROUTER_API_KEY");

  test("a follow-up after stopping a run completes (does not hang)", async ({
    authedPage,
  }) => {
    test.setTimeout(180_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);

      // Real openai-compatible credential → OpenRouter, pinned to smart tier.
      const key = await callSelfMcpTool<{ id: string }>(
        api,
        orgSlug,
        "AI_PROVIDER_KEY_CREATE",
        {
          providerId: "openai-compatible",
          label: `e2e-openrouter-${Date.now()}`,
          apiKey: JSON.stringify({
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: OPENROUTER_API_KEY,
          }),
        },
      );
      await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
        organizationId: orgId,
        simple_mode: {
          tiers: {
            fast: null,
            smart: { keyId: key.id, modelId: MODEL_ID },
            thinking: null,
            image: null,
            web_search: null,
            deep_research: null,
          },
        },
      });

      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "Stop-followup e2e agent",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const agentId = agent.item.id;
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agentId } },
      );
      const threadId = thread.item.id;

      // ── Control: a plain run on a SEPARATE thread must complete. Proves the
      // provider + streaming pipeline work in this environment, so a later
      // failure is attributable to the stop→follow-up sequence, not infra.
      const controlThread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agentId } },
      );
      const controlId = controlThread.item.id;
      const runControl = await postMessage(
        api,
        orgSlug,
        controlId,
        "Say the single word: banana.",
      );
      expect(runControl.status()).toBe(202);
      await expect(async () => {
        expect(await fetchThreadStatus(db, controlId)).toBe("completed");
        expect(await assistantTextCount(db, controlId)).toBeGreaterThan(0);
      }).toPass({ timeout: 90_000, intervals: [1000, 2000, 5000] });

      // ── Turn A: a long-ish answer so the run is genuinely in-flight when we
      // stop it.
      const runA = await postMessage(
        api,
        orgSlug,
        threadId,
        "Write a 200-word story about a robot. Take your time.",
      );
      expect(runA.status()).toBe(202);

      // Wait until A is actually running (in_progress) before stopping.
      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("in_progress");
      }).toPass({ timeout: 30_000, intervals: [250, 500, 1000] });

      const textCountBefore = await assistantTextCount(db, threadId);

      // ── Stop.
      const cancel = await api.post(
        `/api/${orgSlug}/decopilot/cancel/${threadId}`,
      );
      expect(cancel.status()).toBe(202);

      // ── Turn B: the follow-up, sent IMMEDIATELY after stop — as a real user
      // does (the compose box re-enables the instant stop is clicked), while
      // A's teardown (durable cancel flag, cross-turn registry/fence state) may
      // still be settling. THIS is the contract — B must complete.
      const runB = await postMessage(
        api,
        orgSlug,
        threadId,
        "Say the single word: pineapple.",
      );
      expect(runB.status()).toBe(202);

      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
        // And it actually produced new assistant text (not just a status flip).
        expect(await assistantTextCount(db, threadId)).toBeGreaterThan(
          textCountBefore,
        );
      }).toPass({ timeout: 90_000, intervals: [1000, 2000, 5000] });
    } finally {
      await db.end();
    }
  });
});
