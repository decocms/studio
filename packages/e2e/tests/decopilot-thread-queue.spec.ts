// packages/e2e/tests/decopilot-thread-queue.spec.ts
import { test, expect } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import type { APIRequestContext } from "@playwright/test";

// NOTE: org/user/thread setup pattern mirrors decopilot-messages.spec.ts.

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
        title: "E2E Thread Queue Agent",
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
    {
      data: { virtual_mcp_id: agent.item.id, title: "E2E Thread Queue Thread" },
    },
  );
  return { agentId: agent.item.id, threadId: thread.item.id };
}

/**
 * Seed a thread-gate workflow_status row directly (DBOS-aware fixture). `inputs`
 * MUST be the DBOS serialization envelope {"json":[<context>]} so
 * listWorkflows({loadInput:true}) can parse it. Column set matches
 * decopilot-projector-dbos.spec.ts conventions.
 */
async function seedGate(
  db: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  threadId: string,
  o: { id: string; status: "PENDING" | "ENQUEUED"; at: number; text: string },
): Promise<string> {
  const wfId = `thread-run:${threadId}:${o.id}`;
  const ctx = {
    threadId,
    request: {
      messages: [
        { id: o.id, role: "user", parts: [{ type: "text", text: o.text }] },
      ],
    },
    source: "user-message",
  };
  await db.query(
    `INSERT INTO dbos.workflow_status
       (workflow_uuid, status, name, class_name, config_name, queue_name,
        executor_id, application_version, application_id, recovery_attempts,
        priority, created_at, updated_at, inputs)
     VALUES ($1,$2,'threadGateWorkflow','','','thread-gate',
        'seed-exec','seed-version','seed-app',0,0,$3,$3,$4)`,
    [wfId, o.status, String(o.at), JSON.stringify({ json: [ctx] })],
  );
  return wfId;
}

test("stop cancels a stuck PENDING gate head (frees the partition slot)", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { threadId } = await createAgentAndThread(api, orgSlug);

    // Arrange: a deploy-stranded head holding the slot.
    const wfId = await seedGate(db, threadId, {
      id: "stuck-head",
      status: "PENDING",
      at: Date.now(),
      text: "stuck",
    });

    // Act: hit the stop endpoint.
    const res = await api.post(`/api/${orgSlug}/decopilot/cancel/${threadId}`);
    expect(res.status()).toBe(202);

    // Assert: the gate head is now CANCELLED (slot freed).
    const { rows } = await db.query(
      `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
      [wfId],
    );
    expect((rows[0] as { status: string }).status).toBe("CANCELLED");
  } finally {
    await db.end();
  }
});
