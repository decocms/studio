/**
 * E2E: just-in-time connection gate — the PARENT-agent connect-card path.
 *
 * When a Virtual MCP agent declares a typed slot (an `app_id` requirement)
 * that the invoking user has no matching connection for, the run can't
 * assemble its tools. The decopilot harness throws `SlotUnresolvedError`
 * inside `assembleDecopilotTools` (apps/mesh/src/harnesses/decopilot/index.ts)
 * — deterministically, BEFORE any LLM call — and emits a well-formed
 * UI-message-stream envelope: `start`, a short terminal text part, a
 * `data-connect-required` chunk (rendered as the ConnectCard in chat), and a
 * `finish` chunk. Server-side, `resolveThreadStatus`
 * (apps/mesh/src/api/routes/decopilot/status.ts) maps a response carrying a
 * `data-connect-required` part to thread status `requires_action` (NOT
 * `failed`).
 *
 * Why this is deterministic under a REAL LLM e2e: the parent gate fires during
 * tool assembly, before the model runs, so the card does not depend on the
 * model producing anything. We use a unique synthetic slot app_id
 * (`e2e-missing-<ts>`) for which no connection exists and which cannot fall
 * back to an org-shared one, so `resolveSlot` returns null every time.
 *
 * What this asserts (API/stream level — no browser/LLM dependency):
 *   1. The run's SSE stream contains a `data-connect-required` part whose
 *      `data.appIds` includes the synthetic slot app_id and whose
 *      `data.agentTitle` equals the agent title.
 *   2. The stream also contains a `finish` chunk — the regression guard for
 *      the critical bug where the parent path emitted no `finish` and the
 *      client hung in "streaming" forever.
 *   3. After the run, the thread status is `requires_action` (NOT `failed`) —
 *      the regression guard for the false-failure bug.
 *
 * The subagent / parallel-subtask scenarios are intentionally NOT exercised
 * here: they require the real LLM to choose the `subtask` tool, which is
 * non-deterministic. That boundary already has unit coverage in
 * apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.test.ts.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const BASE_URL = `http://localhost:${process.env.PORT ?? "3000"}`;

interface VirtualMcpItem {
  id: string;
  title: string;
  slots: Array<{ slot_app_id: string }>;
}

/** Resolve the authed user's org id (the slug→id the fixture doesn't carry). */
async function resolveOrgId(
  api: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const res = await api.get("/api/auth/organization/list");
  if (!res.ok()) {
    throw new Error(`organization/list → HTTP ${res.status()}`);
  }
  const body = (await res.json()) as
    | Array<{ id: string; slug: string }>
    | { data?: Array<{ id: string; slug: string }> };
  const orgs = Array.isArray(body) ? body : (body.data ?? []);
  const org = orgs.find((o) => o.slug === orgSlug);
  if (!org?.id) {
    throw new Error(`No org id found for slug ${orgSlug}`);
  }
  return org.id;
}

/**
 * Make decopilot's per-request model resolution deterministic and
 * network-free. `resolveTier(ctx, "smart")` takes a fast path when the org has
 * an explicit `simple_mode.tiers.smart` slot pointing at an existing key — it
 * returns that credentialId/modelId without ever calling the provider's
 * `listModels` (which would hit the network). A dummy key is fine: the parent
 * connect-gate throws during tool assembly, long before any real model call.
 *
 * The credential's providerId ("openrouter") maps to the "decopilot" harness
 * (resolveHarnessId), so the run stays on the decopilot path where the gate
 * lives — we deliberately do NOT pass harnessId: "claude-code" (a different
 * harness that bypasses the gate).
 */
async function seedSmartTier(
  api: APIRequestContext,
  orgSlug: string,
  orgId: string,
): Promise<void> {
  const key = await callSelfMcpTool<{ id: string }>(
    api,
    orgSlug,
    "AI_PROVIDER_KEY_CREATE",
    {
      providerId: "openrouter",
      label: `connect-card-e2e-${Date.now()}`,
      apiKey: "sk-or-e2e-dummy-key",
    },
  );
  await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: orgId,
    simple_mode: {
      tiers: {
        fast: null,
        smart: {
          keyId: key.id,
          modelId: "anthropic/claude-sonnet-4.6",
          title: "Smart (e2e)",
        },
        thinking: null,
        image: null,
        web_research: null,
      },
    },
  });
}

/** Create an agent with one unresolved typed slot; assert the slot persisted. */
async function createAgentWithUnresolvedSlot(
  api: APIRequestContext,
  orgSlug: string,
  slotAppId: string,
): Promise<{ agentId: string; agentTitle: string }> {
  const agentTitle = `Connect Card E2E Agent ${Date.now()}`;
  const created = await callSelfMcpTool<{ item: VirtualMcpItem }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: agentTitle,
        connections: [],
        status: "active",
        pinned: false,
        slots: [{ slot_app_id: slotAppId }],
      },
    },
  );
  const agentId = created.item.id;

  // Read the agent back so the test fails loudly if the slot-create shape was
  // wrong (e.g. a future schema change drops slots silently).
  const fetched = await callSelfMcpTool<{ item: VirtualMcpItem }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_GET",
    { id: agentId },
  );
  expect(fetched.item.slots.map((s) => s.slot_app_id)).toContain(slotAppId);

  return { agentId, agentTitle: created.item.title };
}

/** Pull the cookie header off the Playwright context for raw streaming fetch. */
async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies(BASE_URL);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

interface StreamCapture {
  raw: string;
  parts: Array<{ type: string; data?: Record<string, unknown> }>;
}

/**
 * Tail the per-thread `/stream` SSE endpoint until a `finish` chunk arrives
 * (or the timeout fires), collecting every parsed AI-SDK chunk.
 *
 * The endpoint uses `deliverPolicy: "new"` for an idle thread and purges the
 * JetStream buffer on terminal events, so we MUST be subscribed before the run
 * pumps its chunks. Callers start this (without awaiting) BEFORE POSTing the
 * message and await it after.
 *
 * Wire format is the AI SDK's JSON-to-SSE transform: each chunk is a
 * `data: {json}\n\n` event; `: keepalive\n\n` comment lines are interleaved by
 * the server's keepalive wrapper and ignored here.
 */
async function tailStreamUntilFinish(
  page: Page,
  orgSlug: string,
  threadId: string,
  timeoutMs = 20_000,
): Promise<StreamCapture> {
  const cookie = await cookieHeader(page);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const parts: StreamCapture["parts"] = [];
  let raw = "";

  try {
    const res = await fetch(
      `${BASE_URL}/api/${orgSlug}/decopilot/threads/${threadId}/stream`,
      {
        headers: { cookie, accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    // 204 = no JetStream tail available (NATS not wired). Surface it rather
    // than reading a null body — the caller decides how to fail.
    if (res.status === 204) {
      throw new Error("/stream → HTTP 204 (no JetStream tail available)");
    }
    if (!res.ok || !res.body) {
      throw new Error(`/stream → HTTP ${res.status} (body=${!!res.body})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawFinish = false;

    while (!sawFinish) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      buffer += text;

      // SSE events are separated by a blank line (\n\n).
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue; // skip ": keepalive" comments
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload) as {
              type?: string;
              data?: Record<string, unknown>;
            };
            if (typeof chunk.type === "string") {
              parts.push({ type: chunk.type, data: chunk.data });
              if (chunk.type === "finish") sawFinish = true;
            }
          } catch {
            // Partial / non-JSON line — ignore; the next read completes it.
          }
        }
      }
    }
    reader.releaseLock();
  } catch (err) {
    // The timeout aborts `reader.read()` with an AbortError. That's an
    // expected end-of-wait, not a test failure here — return whatever we
    // captured and let the assertions report the precise gap (with `raw`).
    if (!(err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  return { raw, parts };
}

test("parent agent with an unresolved slot emits a connect-required card + finish, and the thread requires_action (never fails)", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;

  const orgId = await resolveOrgId(api, orgSlug);
  await seedSmartTier(api, orgSlug, orgId);

  // Synthetic, never-connected app_id → resolveSlot returns null every time.
  const slotAppId = `e2e-missing-${Date.now()}`;
  const { agentId, agentTitle } = await createAgentWithUnresolvedSlot(
    api,
    orgSlug,
    slotAppId,
  );

  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: agentId, title: "Connect Card E2E Thread" } },
  );
  const threadId = thread.item.id;

  // Subscribe to the stream BEFORE posting so deliverPolicy:"new" catches the
  // run's chunks live (the buffer is purged on terminal events).
  const streamPromise = tailStreamUntilFinish(page, orgSlug, threadId);

  // POST the user message. The decopilot run is enqueued and returns 202; the
  // gate fires asynchronously during dispatch and pumps the card chunks to the
  // per-thread JetStream subject that the tail above is reading.
  const post = await api.post(
    `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
    {
      data: {
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        agent: { id: agentId },
        branch: "ephemeral",
        // Pin the cluster sandbox so dispatch-target resolution stays
        // in-cluster (loopback) and never needs an online user-desktop link
        // daemon (which this env / CI has none of). Without pinning, the
        // default can resolve to "user-desktop" and 409. "cluster" and
        // "user-desktop" are the only valid kinds (local-docker was removed in
        // the local-docker-sandbox drop). The gate under test lives in the
        // decopilot harness; we intentionally do NOT set harnessId (it derives
        // "decopilot" from the openrouter credential), so the parent
        // connect-gate path still runs.
        sandboxProviderKind: "cluster",
      },
      headers: { "content-type": "application/json" },
    },
  );
  if (post.status() !== 202) {
    // Surface the server's error body to make a tier/config regression obvious
    // instead of failing later on an empty stream.
    const body = await post.text().catch(() => "<unreadable>");
    throw new Error(
      `POST /messages expected 202, got ${post.status()}: ${body}`,
    );
  }

  const capture = await streamPromise;

  // 1. The connect-required card part carries the missing app id + agent title.
  const connect = capture.parts.find((p) => p.type === "data-connect-required");
  expect(
    connect,
    `expected a data-connect-required part; got types: ${capture.parts
      .map((p) => p.type)
      .join(", ")} | raw: ${capture.raw.slice(0, 2000)}`,
  ).toBeTruthy();
  expect(connect?.data?.appIds).toContain(slotAppId);
  expect(connect?.data?.agentTitle).toBe(agentTitle);

  // 2. The stream emitted a `finish` chunk (no-finish bug regression guard).
  expect(capture.parts.some((p) => p.type === "finish")).toBe(true);

  // 3. The thread resolves to requires_action — NOT failed (false-failure
  //    regression guard). The reactor persists this on the FINISH event, so
  //    poll until the terminal status lands.
  await expect
    .poll(
      async () => {
        const got = await callSelfMcpTool<{
          item: { status: string } | null;
        }>(api, orgSlug, "COLLECTION_THREADS_GET", { id: threadId });
        return got.item?.status ?? null;
      },
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .toBe("requires_action");
});
