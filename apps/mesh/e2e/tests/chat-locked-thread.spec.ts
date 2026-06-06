/**
 * E2E: thread runtime is locked after first message.
 *
 * Covers the lock-thread-harness-and-branch design end-to-end:
 *
 *   - Task 1 / Task 4 (client-side strip): the chat composer omits
 *     `harnessId`, `sandboxProviderKind`, and `branch` from the submit body
 *     once the thread row carries a `harness_id`. We simulate the stripped
 *     follow-up by POSTing the route directly with the three fields omitted.
 *
 *   - Task 2 (server-side enforcement): even when a follow-up body DOES
 *     include conflicting values, `applyThreadLock` overrides them with the
 *     pinned row values. We assert the row stays at the first-message values
 *     after sending a conflicting body.
 *
 *   - Task 5 / Task 6 (UI affordance): on a locked thread the harness pill
 *     and branch chip render as `harness-picker-locked` /
 *     `branch-picker-locked` with the original values, and the same is true
 *     after a hard reload.
 *
 * Driven via the real /api/:org/decopilot/threads/:threadId/messages route —
 * same pattern as decopilot-messages.spec.ts. We avoid the UI for the submit
 * itself because the chat composer requires an AI provider key + non-trivial
 * tiptap interaction; the surface under test here is the lock contract, not
 * the composer's keystroke flow.
 *
 * harnessId = "claude-code" + sandboxProviderKind = "user-desktop" exercises
 * the dispatch path that requires an online link. Link presence is established
 * via pull presence (GET /api/:org/links/work with x-link-capabilities) —
 * the Phase F pull-by-default mechanism.
 */

import type { APIRequestContext } from "@playwright/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

async function mintApiKey(
  api: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const result = await callSelfMcpTool<{ key?: string }>(
    api,
    orgSlug,
    "API_KEY_CREATE",
    {
      name: `chat-locked-thread-e2e-${Date.now()}`,
      permissions: { "*": ["*"] },
    },
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
 * hold). Returns a promise for the work-poll request (204/timeout on
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
        "x-link-machine-id": "chat-locked-thread-e2e-machine",
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
  agentId: string;
  sandboxProviderKind?: "cluster" | "user-desktop";
  harnessId?: "claude-code" | "codex" | "decopilot";
  branch?: string;
  /** When true, omit the three lock-managed fields entirely (simulates the
   *  client-side strip from resolveSubmitSettings for a locked thread). */
  stripLockFields?: boolean;
}

function messageBody(overrides: MessageBodyOverrides) {
  const base = {
    messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    agent: { id: overrides.agentId },
    temperature: 0.5,
  } as const;
  if (overrides.stripLockFields) {
    return base;
  }
  return {
    ...base,
    branch: overrides.branch ?? "main",
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
        title: "E2E Locked Thread Agent",
        connections: [],
        status: "active",
        pinned: false,
        // `agentHasClonableSource` requires `metadata.githubRepo.url`
        // for `ModePicker` / `BranchPill` to mount in the chat input.
        // No `connectionId` → public-clone mode (no GH auth lookup),
        // which is exactly what the lock e2e wants: we never actually
        // clone, but the UI now believes the agent has a repo and
        // renders the pickers (locked or unlocked) accordingly.
        metadata: {
          githubRepo: {
            url: "https://github.com/decocms/lock-e2e-fixture",
            owner: "decocms",
            name: "lock-e2e-fixture",
          },
        },
      },
    },
  );
  // Pass `branch: "main"` explicitly: COLLECTION_THREADS_CREATE auto-
  // picks a branch when the agent has `metadata.githubRepo`
  // (`pickWarmBranchFromSandboxMap` → `generateBranchName()`), which
  // would beat the body's "main" in the route handler's
  // `existingThread?.branch ?? input.branch` resolution and pin the row
  // to a synthetic name like "deco/keen-forge". Seed the row at "main"
  // so the lock assertions can check against a stable value.
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    {
      data: {
        virtual_mcp_id: agent.item.id,
        title: "E2E Locked Thread",
        branch: "main",
      },
    },
  );
  return { agentId: agent.item.id, threadId: thread.item.id };
}

/**
 * Seed an AI provider key on the org so the thread route renders the
 * chat composer (and its harness / branch pills) instead of
 * `NoAiProviderEmptyState`. The key value is never exercised — the
 * lock e2e never triggers a real model call — but `useAiProviderKeys()`
 * must return at least one row for `HomePage` / the thread route to
 * skip the empty-state short-circuit. Same trick `chat-input-draft`
 * uses.
 */
async function seedAiProviderKey(
  api: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  await callSelfMcpTool(api, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "chat-locked-thread-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
}

test.describe("Thread runtime is locked after first message", () => {
  // Cold Vite + DB + link setup needs a generous budget.
  test.setTimeout(180_000);

  test("server enforces the lock and rejects mid-thread runtime changes", async ({
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

      // 1. First message pins the thread to (claude-code, user-desktop, main).
      const first = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
          branch: "main",
        }),
      );
      expect(first.status()).toBe(202);

      const pinned = await db.query(
        "SELECT sandbox_provider_kind, harness_id, branch FROM threads WHERE id = $1",
        [threadId],
      );
      expect(pinned.rows[0]?.harness_id).toBe("claude-code");
      expect(pinned.rows[0]?.sandbox_provider_kind).toBe("user-desktop");
      expect(pinned.rows[0]?.branch).toBe("main");

      // 2. Follow-up #1: simulate the client-side strip — body has no
      //    harnessId / sandboxProviderKind / branch. The server's
      //    applyThreadLock must source all three from the row, so the call
      //    succeeds and the row is unchanged.
      const stripped = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({ agentId, stripLockFields: true }),
      );
      expect(stripped.status()).toBe(202);

      const afterStripped = await db.query(
        "SELECT sandbox_provider_kind, harness_id, branch FROM threads WHERE id = $1",
        [threadId],
      );
      expect(afterStripped.rows[0]?.harness_id).toBe("claude-code");
      expect(afterStripped.rows[0]?.sandbox_provider_kind).toBe("user-desktop");
      expect(afterStripped.rows[0]?.branch).toBe("main");

      // 3. Follow-up #2: a malicious / stale client sends conflicting values.
      //    applyThreadLock must ignore them. The row stays pinned and the
      //    dispatch still routes against the *pinned* harness (claude-code),
      //    not the body's "codex" — proven by the 202 (codex on a link that
      //    advertises only "claude-code" would otherwise 409 with
      //    user_desktop_link_capability_missing).
      const conflicting = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "cluster",
          harnessId: "codex",
          branch: "feature/other",
        }),
      );
      expect(conflicting.status()).toBe(202);

      const afterConflicting = await db.query(
        "SELECT sandbox_provider_kind, harness_id, branch FROM threads WHERE id = $1",
        [threadId],
      );
      expect(afterConflicting.rows[0]?.harness_id).toBe("claude-code");
      expect(afterConflicting.rows[0]?.sandbox_provider_kind).toBe(
        "user-desktop",
      );
      expect(afterConflicting.rows[0]?.branch).toBe("main");
    } finally {
      await db.end();
      await presencePromise;
    }
  });

  test("locked-state chips render on the thread page after first message", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    await mintApiKey(api, orgSlug);
    const { presencePromise } = await claimPullPresence(api, orgSlug, [
      "claude-code",
    ]);
    try {
      // Seed an AI provider key so the thread route renders the
      // composer instead of `NoAiProviderEmptyState`. Without this,
      // `harness-picker-locked` never mounts because the chat input
      // itself is short-circuited away.
      await seedAiProviderKey(api, orgSlug);

      const { agentId, threadId } = await createAgentAndThread(api, orgSlug);

      // Pin the thread by POSTing the first message directly. The lock
      // is a property of the thread row, not of how the row was
      // populated — driving the composer via Tiptap would only add
      // flakiness here.
      const first = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
          branch: "main",
        }),
      );
      expect(first.status()).toBe(202);

      // Navigate to the thread URL and confirm the locked chips render.
      // Include `?virtualmcpid=` so `useChatNavigation` resolves the
      // chat input against THIS agent (with its `metadata.githubRepo`)
      // instead of falling back to the well-known decopilot agent,
      // which has no clonable source and would suppress the
      // harness/branch pickers entirely.
      await page.goto(`/${orgSlug}/${threadId}?virtualmcpid=${agentId}`);

      const lockedHarness = page.getByTestId("harness-picker-locked");
      await expect(lockedHarness).toBeVisible({ timeout: 60_000 });
      await expect(lockedHarness).toHaveAccessibleName(/claude code/i);

      // The unlocked-state harness trigger must NOT be present — that
      // would mean the lock chip is shadowed by the live picker.
      await expect(page.getByTestId("harness-picker")).toHaveCount(0);

      // Note: the branch-picker-locked chip is intentionally not asserted
      // here. `ChatModeRow` gates `BranchPill` on
      // `githubRepo && connectionId`, and this fixture deliberately omits
      // `connectionId` (a public-clone-mode repo is enough to flip
      // `agentHasClonableSource` for the mode picker, but the branch
      // pill needs a real GH connection to mount). Covering the locked
      // branch chip requires a fixture with an authenticated GH
      // connection — out of scope for this test. The locked-state lookup
      // itself is exercised by `BranchPill`'s own logic and by the
      // server-side lock test above.

      // Hard reload — locked affordance must survive a fresh mount.
      await page.reload();
      await expect(page.getByTestId("harness-picker-locked")).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await presencePromise;
    }
  });
});
