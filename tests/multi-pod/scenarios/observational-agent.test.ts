/**
 * Observational agents — full e2e through the real cluster against mock-ai.
 *
 * Validates the observer dispatch path end-to-end, with TWO observers on one org
 * (each tracks its own watermark, so a single source thread is observed once per
 * observer):
 *
 *   OBSERVATION_SWEEP_RUN (MCP tool)
 *     → runObservationSweepForOrg → listObservableThreads (real PG, per observer)
 *     → buildObserverRun → resolveExplicitModel → mock-ai /v1/models
 *     → OBSERVATION_GLOBAL_QUEUE wrapper → awaitThreadRun
 *     → dispatchRunAndWait → mock-ai streaming completion
 *     → one observer thread per observer, persisted with status=completed
 *
 * The bug this guards against (an observer run rejected before the model is
 * ever called — e.g. an all-system seed → "No user message found") surfaces as
 * the observer thread never reaching status=completed. The mock-ai default
 * branch (5 chunks @ 50ms) makes the happy path finish well within budget.
 *
 * inactiveMinutes:0 means "observe on the next sweep with no settle delay", so
 * the freshly-created source thread is eligible immediately — no DB backdating
 * (this harness is HTTP/MCP-only by design).
 */

import { describe, expect, test } from "bun:test";
import { postJson } from "../lib/client";
import { registerTestHooks } from "../lib/hooks";
import { PODS, type PodInfo } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import {
  bootstrapSession,
  createTestAgent,
  createTestThread,
  type Session,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

interface McpEnvelope<T> {
  result?: {
    structuredContent?: T;
    content?: Array<{ text?: string }>;
  };
  error?: { code?: number; message?: string };
}

/** Call a built-in MCP tool against `{orgId}_self` with Bearer auth. */
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

interface SweepResult {
  observed: number;
  skipped: number;
}

interface ThreadItem {
  id: string;
  status: string;
  virtual_mcp_id?: string;
}

interface ListedThreads {
  items?: ThreadItem[];
}

describe("observational agents (e2e through the real cluster)", () => {
  test("sweep fires a run per observer; each completes via mock-ai", async () => {
    const session = await bootstrapSession(PODS.MESH_1);
    // Register mock-ai as a provider (also pins the smart/fast tiers); we pin
    // each observer to its specific model below to exercise resolveExplicitModel.
    const mock = await wireMockProvider(PODS.MESH_1, session);

    const observerA = await createTestAgent(PODS.MESH_1, session);
    const observerB = await createTestAgent(PODS.MESH_1, session);
    const source = await createTestAgent(PODS.MESH_1, session);

    // Enable observation FIRST (no settle delay) with TWO observers, so the
    // source thread below is created AFTER enablement — observation is
    // forward-only, so enabling never backfills pre-existing threads. The
    // settings upsert merges, so wireMockProvider's tier config survives.
    const model = { keyId: mock.keyId, modelId: mock.modelId };
    await mcpCall(PODS.MESH_1, session, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: session.orgId,
      observational_config: {
        observers: [
          { agentId: observerA.virtualMcpId, model },
          { agentId: observerB.virtualMcpId, model },
        ],
      },
    });

    // A normal (non-observer) thread, created after enablement → observable.
    await createTestThread(PODS.MESH_1, session, source.virtualMcpId);

    // Trigger the sweep now instead of waiting for the 15-minute cron. One
    // source thread × two observers → at least two observer runs.
    const sweep = await mcpCall<SweepResult>(
      PODS.MESH_1,
      session,
      "OBSERVATION_SWEEP_RUN",
      {},
    );
    expect(sweep.observed).toBeGreaterThanOrEqual(2);

    // Each observer must produce its own run that reaches status=completed. With
    // the dispatch-contract bug a run is rejected before the model is called and
    // never completes.
    for (const observer of [observerA, observerB]) {
      let observerThread: ThreadItem | undefined;
      await pollUntil(
        async () => {
          const res = await mcpCall<ListedThreads>(
            PODS.MESH_1,
            session,
            "COLLECTION_THREADS_LIST",
            { where: { virtual_mcp_id: observer.virtualMcpId }, limit: 10 },
          );
          observerThread = (res.items ?? []).find(
            (t) => t.status === "completed",
          );
          return Boolean(observerThread);
        },
        {
          timeoutMs: 30_000,
          intervalMs: 500,
          label: `observer-${observer.virtualMcpId}-completes`,
        },
      );

      expect(observerThread?.status).toBe("completed");
      expect(observerThread?.virtual_mcp_id).toBe(observer.virtualMcpId);
    }
  }, 90_000);
});
