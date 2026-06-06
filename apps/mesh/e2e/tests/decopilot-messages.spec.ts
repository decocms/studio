/**
 * E2E: POST /:org/decopilot/threads/:threadId/messages dispatch gating.
 *
 * These assertions used to live in a unit test that mocked resolveTier,
 * model-permissions, dispatch-queue, the sandbox-kind resolver, AND fabricated
 * a StudioContext — then drove the Hono route and checked the HTTP status. That
 * is the bad zone (a route handler with every dependency faked); per TESTING.md
 * a route belongs in e2e, exercised through the real front door.
 *
 * The whole flow is reachable without standing up a model/credential config:
 * sending `harnessId: "claude-code"` makes per-request model resolution a pure
 * static lookup (no resolveTier, no credential row), so the handler runs for
 * real all the way to `resolveDispatchTarget` — the link-gating logic under
 * test — and the pin persistence is asserted against the real thread row.
 *
 * Link state is established via pull presence: GET /api/:org/links/work with
 * x-link-capabilities mints a claim in the NATS KV bucket so
 * resolveDispatchTarget sees the link as online. This is the same mechanism
 * a real pull daemon uses (Phase F pull-by-default cutover).
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import type { APIRequestContext } from "@playwright/test";

async function mintApiKey(
  api: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const result = await callSelfMcpTool<{ key?: string }>(
    api,
    orgSlug,
    "API_KEY_CREATE",
    { name: `decopilot-e2e-${Date.now()}`, permissions: { "*": ["*"] } },
  );
  if (!result.key) {
    throw new Error(
      `API_KEY_CREATE returned no key: ${JSON.stringify(result)}`,
    );
  }
  return result.key;
}

/**
 * Establish pull presence for the authed user with the given capabilities.
 *
 * Fires GET /api/:org/links/work with a short client timeout so the claim
 * lands synchronously at the start of the handler (before the long-poll
 * hold). The claim is visible in /api/links/me once the KV write completes.
 *
 * Returns a promise for the work-poll request itself (204/timeout on
 * expiry — callers should await it in a finally block to drain the conn).
 */
async function claimPullPresence(
  api: APIRequestContext,
  orgSlug: string,
  capabilities: string[],
): Promise<{ presencePromise: Promise<unknown> }> {
  const presencePromise = api
    .get(`/api/${orgSlug}/links/work`, {
      timeout: 1_500,
      headers: {
        "x-link-capabilities": capabilities.join(","),
        "x-link-machine-id": "decopilot-e2e-machine",
        "x-link-cli-version": "0.0.0-e2e",
      },
    })
    .catch(() => null);

  // Poll until the claim is visible via /api/links/me.
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/links/me");
        if (res.status() !== 200) return null;
        return (await res.json()) as unknown;
      },
      { timeout: 10_000, intervals: [200, 500, 1_000] },
    )
    .not.toBeNull();

  return { presencePromise };
}

interface MessageBodyOverrides {
  agentId?: string;
  sandboxProviderKind?: "cluster" | "user-desktop";
  harnessId?: "claude-code" | "codex" | "decopilot";
}

function messageBody(overrides: MessageBodyOverrides = {}) {
  return {
    messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    agent: { id: overrides.agentId ?? "agent_e2e" },
    branch: "ephemeral",
    temperature: 0.5,
    ...(overrides.sandboxProviderKind
      ? { sandboxProviderKind: overrides.sandboxProviderKind }
      : {}),
    ...(overrides.harnessId ? { harnessId: overrides.harnessId } : {}),
  };
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
  body: ReturnType<typeof messageBody>,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: body,
    headers: { "content-type": "application/json" },
  });
}

/** Create a real agent (virtual MCP) + thread row; returns both ids. */
async function createAgentAndThread(
  api: APIRequestContext,
  orgSlug: string,
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "E2E Decopilot Agent",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: agent.item.id, title: "E2E Decopilot Thread" } },
  );
  return { agentId: agent.item.id, threadId: thread.item.id };
}

test.describe("POST /messages — dispatch target gating", () => {
  test("user-desktop kind + no online link → 409 user_desktop_link_offline", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const res = await postMessage(
      api,
      orgSlug,
      "thread_e2e_offline",
      messageBody({
        sandboxProviderKind: "user-desktop",
        harnessId: "claude-code",
      }),
    );

    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("link_unavailable");
    expect(body.code).toBe("user_desktop_link_offline");
  });

  test("user-desktop kind + link missing capability → 409 user_desktop_link_capability_missing", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    await mintApiKey(api, orgSlug);
    // Claim presence advertising only decopilot-sandbox; a claude-code harness
    // needs the "claude-code" capability.
    const { presencePromise } = await claimPullPresence(api, orgSlug, [
      "decopilot-sandbox",
    ]);
    try {
      const res = await postMessage(
        api,
        orgSlug,
        "thread_e2e_capmiss",
        messageBody({
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      );

      expect(res.status()).toBe(409);
      const body = (await res.json()) as {
        code: string;
        activeCapabilities: string[];
      };
      expect(body.code).toBe("user_desktop_link_capability_missing");
      expect(body.activeCapabilities).toEqual(["decopilot-sandbox"]);
    } finally {
      await presencePromise;
    }
  });

  test("cloud kind (cluster) → 202 (no link required)", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const { agentId, threadId } = await createAgentAndThread(api, orgSlug);
    const res = await postMessage(
      api,
      orgSlug,
      threadId,
      messageBody({
        agentId,
        sandboxProviderKind: "cluster",
        harnessId: "claude-code",
      }),
    );

    expect(res.status()).toBe(202);
  });
});

test.describe("POST /messages — first-message pinning", () => {
  test("first message persists sandbox/harness pins on the thread row", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    await mintApiKey(api, orgSlug);
    // Claim presence advertising "claude-code" capability.
    const { presencePromise } = await claimPullPresence(api, orgSlug, [
      "claude-code",
    ]);
    const db = await connectDevDb();
    try {
      const { agentId, threadId } = await createAgentAndThread(api, orgSlug);

      const res = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      );
      expect(res.status()).toBe(202);

      const { rows } = await db.query(
        "SELECT sandbox_provider_kind, harness_id FROM threads WHERE id = $1",
        [threadId],
      );
      expect(rows[0]?.sandbox_provider_kind).toBe("user-desktop");
      expect(rows[0]?.harness_id).toBe("claude-code");
    } finally {
      await db.end();
      await presencePromise;
    }
  });

  test("subsequent message keeps the pinned sandbox kind and ignores a conflicting body", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    await mintApiKey(api, orgSlug);
    const { presencePromise } = await claimPullPresence(api, orgSlug, [
      "claude-code",
    ]);
    const db = await connectDevDb();
    try {
      const { agentId, threadId } = await createAgentAndThread(api, orgSlug);

      // First message pins (user-desktop, claude-code).
      const first = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      );
      expect(first.status()).toBe(202);

      // Second message sends a conflicting sandbox kind (cluster). The
      // thread row already pins user-desktop, which is the single source of
      // truth — the body's kind must be ignored. We keep harnessId
      // "claude-code" here on purpose: a non-CLI harness in the body (e.g.
      // "decopilot") would force real per-request model resolution via
      // resolveTier, which 400s on an org with no model configured. (The old
      // unit test only "passed" that path because it mocked resolveTier — the
      // real front door exposes the dependency.)
      const second = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "cluster",
          harnessId: "claude-code",
        }),
      );
      expect(second.status()).toBe(202);

      // The conflicting body did not overwrite the pinned values: the row is
      // still user-desktop, not cluster.
      const { rows } = await db.query(
        "SELECT sandbox_provider_kind, harness_id FROM threads WHERE id = $1",
        [threadId],
      );
      expect(rows[0]?.sandbox_provider_kind).toBe("user-desktop");
      expect(rows[0]?.harness_id).toBe("claude-code");
    } finally {
      await db.end();
      await presencePromise;
    }
  });
});
