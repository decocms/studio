/**
 * Webhook-triggered automations — full e2e through the real cluster.
 *
 * Validates the path introduced in PR #3426 end-to-end:
 *
 *   POST /api/:org/webhooks/:triggerId
 *     → verifyApiKey against Better Auth (real)
 *     → ctx.storage.automations.findTriggerById + findById (real PG)
 *     → enqueueAutomationFire → orgGateWorkflow → fireAutomationWorkflow
 *       → dispatchRunAndWait → mock-ai streaming completion
 *     → thread row persisted with status=completed and trigger_id set
 *
 * Cross-pod twist: we mint the trigger on pod-1 but POST the webhook
 * against pod-2. The Bearer token (Better Auth API key) lives in shared
 * Postgres, the trigger row lives in shared Postgres, and DBOS picks
 * whichever pod is free — so the fire works regardless of who handled
 * the POST. If anything in that chain depended on pod-local state, the
 * cross-pod variant fails while a pod-1→pod-1 variant would mask it.
 *
 * Two assertions per token lifecycle:
 *   1. POST → 202 + thread for our trigger reaches status=completed.
 *   2. After AUTOMATION_TRIGGER_ROTATE_TOKEN, the *old* token must be
 *      rejected — proves rotation actually invalidates predecessors.
 */

import { describe, expect, test } from "bun:test";
import { fetchOn, postJson } from "../lib/client";
import { registerTestHooks } from "../lib/hooks";
import { PODS, type PodInfo } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import {
  bootstrapSession,
  createTestAgent,
  type Session,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

// ----------------------------------------------------------------------------
// Generic MCP tool-call helper (pod-pinned, structured-content first)
// ----------------------------------------------------------------------------

interface McpEnvelope<T> {
  result?: {
    structuredContent?: T;
    content?: Array<{ text?: string }>;
  };
  error?: { code?: number; message?: string };
}

/**
 * Call a built-in MCP tool against `{orgId}_self`. Bearer auth (matches
 * production decopilot/webhook auth). Returns the structured payload, or
 * parses text fallback for older tools.
 */
async function mcpCall<T = unknown>(
  pod: PodInfo,
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await postJson(
    pod,
    `/mcp/${session.orgId}_self`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    {
      auth: { apiKey: session.apiKey },
      headers: { Accept: "application/json, text/event-stream" },
    },
  );
  const json = (await res.json()) as McpEnvelope<T>;
  if (json.error) {
    throw new Error(
      `${name} JSON-RPC error: ${json.error.message ?? JSON.stringify(json.error)}`,
    );
  }
  const structured = json.result?.structuredContent as
    | Record<string, unknown>
    | undefined;
  if (structured && Object.keys(structured).length > 0) return structured as T;
  const text = json.result?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      /* fall through */
    }
  }
  return (structured ?? {}) as T;
}

// ----------------------------------------------------------------------------
// Domain helpers tailored to the webhook flow
// ----------------------------------------------------------------------------

interface CreatedAutomation {
  id: string;
  name: string;
  active: boolean;
  kind: "agent" | "tool_call";
}

interface CreatedWebhookTrigger {
  id: string;
  automation_id: string;
  type: "cron" | "event" | "webhook";
  webhook?: { url: string; token: string } | null;
}

interface RotatedToken {
  trigger_id: string;
  url: string;
  token: string;
}

interface ListedThreads {
  items?: Array<{
    id: string;
    status: string;
    trigger_id?: string | null;
  }>;
}

async function createAgentAutomation(
  pod: PodInfo,
  session: Session,
  virtualMcpId: string,
): Promise<CreatedAutomation> {
  // mock-ai's default branch ("5 chunks @ 50ms") fires whenever the user
  // text has no hints, so the prompt itself just needs to exist. We keep
  // it short to keep the run under the 30s poll budget.
  return mcpCall<CreatedAutomation>(pod, session, "AUTOMATION_CREATE", {
    name: `webhook-e2e-${Date.now()}`,
    kind: "agent",
    virtual_mcp_id: virtualMcpId,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "respond with anything" }],
      },
    ],
    models: { tier: "smart" },
    active: true,
  });
}

async function addWebhookTrigger(
  pod: PodInfo,
  session: Session,
  automationId: string,
): Promise<CreatedWebhookTrigger> {
  const trig = await mcpCall<CreatedWebhookTrigger>(
    pod,
    session,
    "AUTOMATION_TRIGGER_ADD",
    { automation_id: automationId, type: "webhook" },
  );
  if (!trig.webhook?.token) {
    throw new Error(
      `AUTOMATION_TRIGGER_ADD did not return webhook token: ${JSON.stringify(trig)}`,
    );
  }
  return trig;
}

/**
 * Build the webhook URL targeting a specific pod's host port. We don't
 * reuse the URL returned by AUTOMATION_TRIGGER_ADD because that one is
 * stamped with whatever `BASE_URL` the mesh process saw at mint time
 * (the in-container `http://localhost:3000` in compose) — useless from
 * the test process, and we want to deliberately POST against a chosen
 * pod for the cross-pod assertion.
 */
function webhookUrlFor(
  pod: PodInfo,
  session: Session,
  triggerId: string,
): string {
  return `${pod.baseUrl}/api/${session.orgSlug}/webhooks/${triggerId}`;
}

/** Direct fetch (no auth headers) so we drive exactly what an external
 *  sender would: a plain POST with `Authorization: Bearer <token>`. */
async function postWebhook(
  pod: PodInfo,
  url: string,
  token: string,
  payload: unknown,
): Promise<Response> {
  // `url` already includes the pod's host:port, but `fetchOn` wants a
  // path. Strip the origin so we can reuse its `Origin` header logic
  // (Better Auth requires Origin to match BETTER_AUTH_URL).
  const path = new URL(url).pathname;
  return fetchOn(pod, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // Bearer is the *webhook* token (validated by the route's own
    // verifyWebhookToken), NOT the session apiKey. We set the header
    // explicitly so fetchOn doesn't try to inject something else.
    auth: { apiKey: token },
  });
}

/** Poll thread list filtered by trigger_id until a completed run shows up. */
async function waitForCompletedRun(
  pod: PodInfo,
  session: Session,
  triggerId: string,
  timeoutMs: number,
): Promise<{ id: string; status: string; trigger_id?: string | null }> {
  let last: ListedThreads["items"] = [];
  await pollUntil(
    async () => {
      const res = await mcpCall<ListedThreads>(
        pod,
        session,
        "COLLECTION_THREADS_LIST",
        { where: { trigger_ids: [triggerId] }, limit: 10 },
      );
      last = res.items ?? [];
      return last.some((t) => t.status === "completed");
    },
    {
      timeoutMs,
      intervalMs: 500,
      label: `webhook-fire-completes-for-${triggerId}`,
    },
  );
  const done = last.find((t) => t.status === "completed");
  if (!done)
    throw new Error("no completed thread after poll (shouldn't happen)");
  return done;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("automation webhook trigger (e2e through the real cluster)", () => {
  test("POST to a webhook trigger on pod-2 fires the automation and the run completes", async () => {
    // Setup runs against pod-1; the webhook POST itself targets pod-2 to
    // exercise the cross-pod path.
    const session = await bootstrapSession(PODS.MESH_1);
    await wireMockProvider(PODS.MESH_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.MESH_1, session);

    const automation = await createAgentAutomation(
      PODS.MESH_1,
      session,
      virtualMcpId,
    );
    expect(automation.active).toBe(true);

    const trigger = await addWebhookTrigger(
      PODS.MESH_1,
      session,
      automation.id,
    );
    const token = trigger.webhook!.token;

    // -------- cross-pod fire --------
    const url = webhookUrlFor(PODS.MESH_2, session, trigger.id);
    const res = await postWebhook(PODS.MESH_2, url, token, {
      source: "e2e-test",
      ping: "pong",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; trigger_id: string };
    expect(body).toEqual({ ok: true, trigger_id: trigger.id });

    // -------- the run actually happens --------
    // mock-ai's default branch finishes in ~250ms, but the full chain
    // (DBOS gate → workflow → dispatchRunAndWait → streamText drain →
    // thread status update) crosses several DB writes and a queue
    // hop. 30s is generous and matches the budget used elsewhere in
    // this suite.
    const completed = await waitForCompletedRun(
      PODS.MESH_1,
      session,
      trigger.id,
      30_000,
    );
    expect(completed.trigger_id).toBe(trigger.id);
  }, 60_000);

  test("AUTOMATION_TRIGGER_ROTATE_TOKEN revokes the old token and the new one fires", async () => {
    const session = await bootstrapSession(PODS.MESH_1);
    await wireMockProvider(PODS.MESH_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.MESH_1, session);
    const automation = await createAgentAutomation(
      PODS.MESH_1,
      session,
      virtualMcpId,
    );
    const trigger = await addWebhookTrigger(
      PODS.MESH_1,
      session,
      automation.id,
    );
    const oldToken = trigger.webhook!.token;

    // Rotate via the MCP tool. Best-effort revocation: even if Better
    // Auth's delete fails, the trigger row's api_key_id is swapped
    // atomically — and the webhook route's "stale token" check refuses
    // to fire on any key whose id != trigger.api_key_id. That's what
    // we're nailing down here.
    const rotated = await mcpCall<RotatedToken>(
      PODS.MESH_1,
      session,
      "AUTOMATION_TRIGGER_ROTATE_TOKEN",
      { trigger_id: trigger.id },
    );
    expect(rotated.token).toBeTruthy();
    expect(rotated.token).not.toBe(oldToken);

    const url = webhookUrlFor(PODS.MESH_1, session, trigger.id);

    // Old token: must be refused. Acceptable codes are 401 (key was
    // revoked outright OR key.id doesn't match trigger.api_key_id any
    // more) or 403 (key still validates but its scoped permission was
    // dropped). Both are correct outcomes; the *wrong* outcome is 202.
    const oldRes = await postWebhook(PODS.MESH_1, url, oldToken, {});
    expect([401, 403]).toContain(oldRes.status);

    // New token: should fire end-to-end like a fresh trigger.
    const newRes = await postWebhook(PODS.MESH_1, url, rotated.token, {
      ping: "after-rotate",
    });
    expect(newRes.status).toBe(202);

    await waitForCompletedRun(PODS.MESH_1, session, trigger.id, 30_000);
  }, 60_000);
});
