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
 * Link presence is real: the user is made a live `user-desktop` link via
 * `claimPullPresence` (a `GET /links/work` long-poll that synthetically mints
 * the presence claim, the same path a pull daemon takes). These tests never
 * await a dispatch — they only need the link to be *present* in the claim
 * registry so `resolveDispatchTarget` routes correctly (Phase C-bis S6).
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { claimPullPresence } from "../fixtures/links-presence";
import type { APIRequestContext } from "@playwright/test";

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

    // Link advertises only decopilot-sandbox; a claude-code harness needs the
    // "claude-code" capability.
    const presence = claimPullPresence(api, ["decopilot-sandbox"]);
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
      await presence;
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

    // user-desktop + claude-code resolves OK only when the link advertises it.
    const presence = claimPullPresence(api, ["claude-code"]);
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
      await presence;
    }
  });

  test("subsequent message keeps the pinned sandbox kind and ignores a conflicting body", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const presence = claimPullPresence(api, ["claude-code"]);
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
      await presence;
    }
  });
});
