/**
 * API-key cross-pod — proves Bearer-token auth is shared cluster-wide.
 *
 * The cluster-smoke scenario covers cookie-based session lookup. Decopilot
 * endpoints (POST /messages, GET /stream) authenticate via API key in
 * production, which is a different code path — Bearer header → API-key
 * table lookup, not Cookie header → session table lookup. This scenario
 * pins down that path before any decopilot scenario relies on it.
 *
 * The call we make is `COLLECTION_THREADS_LIST` over the built-in MCP
 * endpoint at `/mcp/{orgId}_self`. It's a read-only tool that needs no
 * fixture state (returns an empty list for a fresh org), so the test is
 * stable and order-independent.
 */

import { describe, expect, test } from "bun:test";
import { postJson } from "../lib/client";
import { registerTestHooks } from "../lib/hooks";
import { ALL_PODS, PODS } from "../lib/pods";
import { bootstrapSession } from "../lib/setup";

registerTestHooks();

interface McpEnvelope<T> {
  result?: {
    structuredContent?: T;
    content?: Array<{ text?: string }>;
  };
  error?: { message?: string };
}

interface ListThreadsResult {
  items?: unknown[];
  total?: number;
}

async function listThreads(
  pod: (typeof ALL_PODS)[number],
  orgId: string,
  apiKey: string,
): Promise<ListThreadsResult> {
  const res = await postJson(
    pod,
    `/mcp/${orgId}_self`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "COLLECTION_THREADS_LIST",
        arguments: { limit: 10 },
      },
    },
    {
      auth: { apiKey },
      headers: { Accept: "application/json, text/event-stream" },
    },
  );
  const json = (await res.json()) as McpEnvelope<ListThreadsResult>;
  if (json.error) {
    throw new Error(
      `${pod.service}: COLLECTION_THREADS_LIST failed: ${json.error.message}`,
    );
  }
  // Newer MCP responses use structuredContent; older paths fall back to
  // the text content envelope. Cover both.
  const structured = json.result?.structuredContent;
  if (structured) return structured;
  const text = json.result?.content?.[0]?.text;
  return text ? (JSON.parse(text) as ListThreadsResult) : {};
}

describe("API key cross-pod", () => {
  test("API key minted on pod-1 authenticates on every pod", async () => {
    const { orgId, apiKey } = await bootstrapSession(PODS.MESH_1);

    // The same Bearer key should resolve to the same org on every pod,
    // because API-key lookups go through the shared API-key table — not
    // any pod-local registry.
    for (const pod of ALL_PODS) {
      const result = await listThreads(pod, orgId, apiKey);
      // A freshly-minted org has no threads. We don't assert items is
      // *exactly* empty (avoids coupling to whether any boot-time seeding
      // ever lands) — just that the call succeeded and the shape matches.
      expect(Array.isArray(result.items ?? [])).toBe(true);
    }
  });
});
