// packages/e2e/tests/decopilot-thread-queue.spec.ts
import { test, expect, newApiContext } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";
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

test("GET queue lists PENDING + ENQUEUED gate messages, oldest first", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { threadId } = await createAgentAndThread(api, orgSlug);

    await seedGate(db, threadId, {
      id: "head",
      status: "PENDING",
      at: 1000,
      text: "running one",
    });
    await seedGate(db, threadId, {
      id: "q2",
      status: "ENQUEUED",
      at: 3000,
      text: "second",
    });
    await seedGate(db, threadId, {
      id: "q1",
      status: "ENQUEUED",
      at: 2000,
      text: "first",
    });

    const res = await api.get(`/api/${orgSlug}/decopilot/queue/${threadId}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ messageId: string; status: string; text: string }>;
    };
    expect(body.items.map((i) => i.messageId)).toEqual(["head", "q1", "q2"]);
    expect(body.items[0]).toMatchObject({
      status: "running",
      text: "running one",
    });
    expect(body.items[1]).toMatchObject({ status: "queued", text: "first" });
  } finally {
    await db.end();
  }
});

test("GET queue 403s for a non-owner", async ({ authedPage, playwright }) => {
  const { page, orgSlug } = authedPage;
  const ownerApi = page.context().request;

  // Create a thread owned by the primary user.
  const { threadId } = await createAgentAndThread(ownerApi, orgSlug);

  // A second user who has no membership in orgSlug.
  const otherCtx = await newApiContext(playwright);
  await signUpViaApi(otherCtx);

  try {
    // The other user tries to read the owner's thread queue — should 403.
    const res = await otherCtx.get(
      `/api/${orgSlug}/decopilot/queue/${threadId}`,
    );
    expect(res.status()).toBe(403);
  } finally {
    await otherCtx.dispose();
  }
});

test("POST cancel removes a queued item", async ({ authedPage }) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { threadId } = await createAgentAndThread(api, orgSlug);

    const wfId = await seedGate(db, threadId, {
      id: "to-cancel",
      status: "ENQUEUED",
      at: Date.now(),
      text: "x",
    });

    const res = await api.post(
      `/api/${orgSlug}/decopilot/queue/${threadId}/cancel/${encodeURIComponent(wfId)}`,
    );
    expect(res.status()).toBe(202);

    const { rows } = await db.query(
      `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
      [wfId],
    );
    expect((rows[0] as { status: string }).status).toBe("CANCELLED");
  } finally {
    await db.end();
  }
});

test("POST cancel 404s for a workflowId scoped to another thread", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;

  const { threadId } = await createAgentAndThread(api, orgSlug);

  const foreign = encodeURIComponent("thread-run:someone-else:msg-1");
  const res = await api.post(
    `/api/${orgSlug}/decopilot/queue/${threadId}/cancel/${foreign}`,
  );
  expect(res.status()).toBe(404);
});

test("POST externalizes a data: attachment out of the DBOS workflow input", async ({
  authedPage,
}) => {
  // Object storage (S3 + org-fs) must be available for this assertion to hold:
  // uploadFileParts only materializes when ctx.orgFs is present, which requires
  // a real S3-backed objectStorage. Skip on plain local dev without MinIO.
  test.skip(
    !(
      process.env.S3_ENDPOINT &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY
    ),
    "requires S3 env (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY); see e2e.yml MinIO setup",
  );

  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { agentId, threadId } = await createAgentAndThread(api, orgSlug);

    // A tiny 1×1 PNG as a data: URL — represents a user-attached image.
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const messageId = `img-${Date.now()}`;

    const res = await api.post(
      `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
      {
        data: {
          messages: [
            {
              id: messageId,
              role: "user",
              parts: [
                { type: "text", text: "describe this" },
                {
                  type: "file",
                  url: tinyPng,
                  mediaType: "image/png",
                  filename: "a.png",
                },
              ],
            },
          ],
          agent: { id: agentId },
          branch: "ephemeral",
          harnessId: "decopilot",
          temperature: 0.5,
        },
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status()).toBe(202);

    // The persisted gate input must NOT contain the base64 data: blob.
    // `inputs` is a TEXT column (the {"json":[ctx]} envelope) — read as string.
    const wfId = `thread-run:${threadId}:${messageId}`;
    const { rows } = await db.query(
      `SELECT inputs FROM dbos.workflow_status WHERE workflow_uuid = $1`,
      [wfId],
    );
    const serialized = String(
      (rows[0] as { inputs: string } | undefined)?.inputs ?? "",
    );
    expect(serialized).not.toContain("data:image/png;base64,");
    expect(serialized).toContain("mesh-storage:");
  } finally {
    await db.end();
  }
});
