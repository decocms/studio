/**
 * local-api e2e: the REAL production web shell's wire contract, served
 * LOCALLY by `crates/local-api/src/routes/intercept/`. Owner
 * course-correction — see the native interception contract
 * (the recon this suite pins) and
 * the native local-API contract
 * (the contract section this file is the black-box oracle for).
 *
 * Every route here is reached through the bare app-API fallback (the SAME
 * proxy `upstream-auth-proxy.e2e.test.ts` exercises — no `/upstream` prefix
 * since the port-router split) — the interception table is consulted
 * BEFORE any upstream forwarding decision. Account-scoped thread/chat routes
 * still require the real upstream identity established by the public Better
 * Auth -> OAuth completion bridge; `LINK_CURRENT_GET` deliberately remains
 * available while signed out. Contrast with
 * `real-ui-passthrough.e2e.test.ts`, which asserts the OTHER half: a route
 * this table does NOT recognize still needs a real bearer to reach the
 * (stub) upstream.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { retry } from "@decocms/shared/std";

import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  stubClaudeBinEnv,
  url,
} from "./helpers";

/** Parses `event: message\ndata: <json>\n\n` frames — decopilot's real SSE
 *  framing (map §3.2), distinct from `/_sandbox/dispatch`'s data-only
 *  framing `parseDispatchFrames` already covers. */
function parseMessageEvents(sseText: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of sseText.split("\n\n")) {
    let isMessageEvent = false;
    let data: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:"))
        isMessageEvent = line.slice(6).trim() === "message";
      if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (isMessageEvent && data) {
      events.push(JSON.parse(data) as Record<string, unknown>);
    }
  }
  return events;
}

let orgCounter = 0;
/** A fresh org slug per test — `rt_threads` scopes by `organization_id`, so
 *  this is what keeps assertions from observing another test's rows (all
 *  tests in a `describeLocalApi` block share one `local-api` process/db). */
function freshOrg(): string {
  orgCounter += 1;
  return `org-${orgCounter}`;
}

describeLocalApi("local-api e2e: real-UI interception — thread tools", () => {
  let a: LocalApi;
  let stub: ReturnType<typeof startAttribStubMesh>;
  beforeAll(async () => {
    // Thread-delete cascade coverage below sends one deterministic chat turn;
    // the other tests remain pure thread-tool calls.
    stub = startAttribStubMesh();
    a = await startLocalApi({
      ...stubClaudeBinEnv(),
      DECOCMS_UPSTREAM_URL: stub.url,
      LOCAL_API_TOKEN_STORE: "memory",
    });
    await signInAndCompleteSession(a);
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
    stub.server.stop(true);
  }, HOOK_TIMEOUT_MS);

  it("COLLECTION_THREADS_CREATE + LIST + GET + UPDATE round-trip with the real tool wire shape (no envelope)", async () => {
    const org = freshOrg();

    const createRes = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          data: {
            title: "hello from the real shell",
            virtual_mcp_id: "vmcp-1",
          },
        }),
      },
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    // Raw tool output, no {content,structuredContent} envelope (map §3.1).
    expect(created).not.toHaveProperty("content");
    expect(created.item.title).toBe("hello from the real shell");
    expect(created.item.organization_id).toBe(org);
    expect(created.item.virtual_mcp_id).toBe("vmcp-1");
    expect(created.item.hidden).toBe(false);
    const id = created.item.id as string;

    const listRes = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_LIST`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ limit: 50, offset: 0 }),
      },
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      items: Record<string, unknown>[];
      totalCount: number;
      hasMore: boolean;
    };
    expect(listed.items.map((t) => t.id)).toContain(id);
    expect(listed.totalCount).toBe(1);
    expect(listed.hasMore).toBe(false);

    const getRes = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_GET`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id }),
      },
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      item: Record<string, unknown> | null;
    };
    expect(fetched.item?.id).toBe(id);

    const updateRes = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_UPDATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id, data: { hidden: true, title: "renamed" } }),
      },
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as {
      item: Record<string, unknown>;
    };
    expect(updated.item.hidden).toBe(true);
    expect(updated.item.title).toBe("renamed");
  });

  it("COLLECTION_THREADS_CREATE requires data.virtual_mcp_id (byte-parity with the real tool's schema)", async () => {
    const org = freshOrg();
    const res = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ data: { title: "no vmcp id" } }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("COLLECTION_THREADS_GET on an unknown id returns {item:null}, not a 404", async () => {
    const org = freshOrg();
    const res = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_GET`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id: "does-not-exist" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: unknown };
    expect(body.item).toBeNull();
  });

  it("COLLECTION_THREAD_MESSAGES_LIST on an unknown thread_id is an empty page, not an error", async () => {
    const org = freshOrg();
    const res = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREAD_MESSAGES_LIST`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ thread_id: "does-not-exist" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; totalCount: number };
    expect(body.items).toEqual([]);
    expect(body.totalCount).toBe(0);
  });

  it("id-based thread tools do not disclose or mutate another org's known thread id", async () => {
    const ownerOrg = freshOrg();
    const otherOrg = freshOrg();
    const id = `scoped-${ownerOrg}`;
    const createBody = (title: string) =>
      JSON.stringify({
        data: { id, title, virtual_mcp_id: "vmcp-scoped" },
      });

    const ownerCreate = await fetch(
      url(a, `/api/${ownerOrg}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: createBody("owner title"),
      },
    );
    expect(ownerCreate.status).toBe(200);

    const collidingCreate = await fetch(
      url(a, `/api/${otherOrg}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: createBody("foreign title"),
      },
    );
    expect(collidingCreate.status).toBe(409);
    expect(await collidingCreate.json()).toEqual({
      error: "thread id is unavailable",
    });

    const foreignGet = await fetch(
      url(a, `/api/${otherOrg}/tools/COLLECTION_THREADS_GET`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id }),
      },
    );
    expect(foreignGet.status).toBe(200);
    expect(await foreignGet.json()).toEqual({ item: null });

    const foreignUpdate = await fetch(
      url(a, `/api/${otherOrg}/tools/COLLECTION_THREADS_UPDATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id, data: { title: "hijacked" } }),
      },
    );
    expect(foreignUpdate.status).toBe(404);

    const foreignMessages = await fetch(
      url(a, `/api/${otherOrg}/tools/COLLECTION_THREAD_MESSAGES_LIST`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ thread_id: id }),
      },
    );
    expect(foreignMessages.status).toBe(200);
    expect(await foreignMessages.json()).toEqual({
      items: [],
      totalCount: 0,
      hasMore: false,
    });

    const foreignDelete = await fetch(
      url(a, `/api/${otherOrg}/tools/COLLECTION_THREADS_DELETE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id }),
      },
    );
    expect(foreignDelete.status).toBe(404);

    const ownerGet = await fetch(
      url(a, `/api/${ownerOrg}/tools/COLLECTION_THREADS_GET`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id }),
      },
    );
    const owner = (await ownerGet.json()) as {
      item: { title: string } | null;
    };
    expect(owner.item?.title).toBe("owner title");
  });

  it("COLLECTION_THREADS_DELETE is local and cascades a thread's persisted messages", async () => {
    const org = freshOrg();
    const threadId = `delete-cascade-${org}`;
    const createRes = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          data: {
            id: threadId,
            title: "delete me",
            virtual_mcp_id: "vmcp-delete",
          },
        }),
      },
    );
    expect(createRes.status).toBe(200);

    const sendRes = await fetch(
      url(a, `/api/${org}/decopilot/threads/${threadId}/messages`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          messages: [
            {
              id: `user-${threadId}`,
              role: "user",
              parts: [{ type: "text", text: "SCENARIO:simple" }],
            },
          ],
          harnessId: "claude-code",
          tier: "smart",
          mode: "default",
          toolApprovalLevel: "auto",
        }),
      },
    );
    expect(sendRes.status).toBe(202);
    const streamRes = await fetch(
      url(a, `/api/${org}/decopilot/threads/${threadId}/stream`),
      { headers: authHeaders() },
    );
    expect(streamRes.status).toBe(200);
    await streamRes.text();

    const listMessages = () =>
      fetch(url(a, `/api/${org}/tools/COLLECTION_THREAD_MESSAGES_LIST`), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ thread_id: threadId }),
      });
    const beforeDelete = await listMessages();
    const beforeBody = (await beforeDelete.json()) as {
      items: unknown[];
      totalCount: number;
    };
    expect(beforeBody.totalCount).toBe(2);
    expect(beforeBody.items).toHaveLength(2);

    const deleteRes = await fetch(
      url(a, `/api/${org}/tools/COLLECTION_THREADS_DELETE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ id: threadId }),
      },
    );
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as {
      item: { id: string; title: string };
    };
    expect(deleted.item).toMatchObject({ id: threadId, title: "delete me" });

    const afterDelete = await listMessages();
    expect(await afterDelete.json()).toEqual({
      items: [],
      totalCount: 0,
      hasMore: false,
    });
  });

  it("LINK_CURRENT_GET always reports online:true with a capabilities array, answered locally", async () => {
    const org = freshOrg();
    const res = await fetch(url(a, `/api/${org}/tools/LINK_CURRENT_GET`), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      online: boolean;
      capabilities: string[];
    };
    expect(body.online).toBe(true);
    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  it("an unrecognized tool name is NOT intercepted (the authenticated ordinary upstream proxy reaches the stub)", async () => {
    const org = freshOrg();
    const res = await fetch(url(a, `/api/${org}/tools/SOME_OTHER_TOOL`), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({}),
    });
    // The auth stub's catch-all answers plain text 404. A local intercepted
    // tool would instead return one of the structured collection responses.
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});

describeLocalApi(
  "local-api e2e: real-UI interception — decopilot dispatch (stub harness)",
  () => {
    let a: LocalApi;
    let stub: ReturnType<typeof startAttribStubMesh>;
    beforeAll(async () => {
      // The stub CLI makes harness resolution deterministic regardless of
      // what's actually installed on the machine running this suite — see
      // `stubClaudeBinEnv`'s doc comment.
      stub = startAttribStubMesh();
      a = await startLocalApi({
        ...stubClaudeBinEnv(),
        DECOCMS_UPSTREAM_URL: stub.url,
        LOCAL_API_TOKEN_STORE: "memory",
      });
      await signInAndCompleteSession(a);
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => {
      await stopLocalApi(a);
      stub.server.stop(true);
    }, HOOK_TIMEOUT_MS);

    it("POST messages 202s with a taskId, then the stream carries the user-message mirror, harness chunks, and a finish event", async () => {
      const org = freshOrg();
      const threadId = `thread-${org}`;

      const dispatchRes = await fetch(
        url(a, `/api/${org}/decopilot/threads/${threadId}/messages`),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "SCENARIO:simple" }],
              },
            ],
            tier: "smart",
            mode: "default",
            toolApprovalLevel: "auto",
            agent: { id: "agent-1" },
            harnessId: "claude-code",
          }),
        },
      );
      expect(dispatchRes.status).toBe(202);
      const dispatchBody = (await dispatchRes.json()) as { taskId: string };
      expect(typeof dispatchBody.taskId).toBe("string");
      expect(dispatchBody.taskId.length).toBeGreaterThan(0);

      // Read the stream to its NATURAL end (not an early-stopping
      // predicate like `readSseUntil`'s other callers use) — the response
      // body only closes once `DecopilotRun::finish()` closes the disk-backed
      // spool's live sender, which (see `run_harness_and_stream`) happens
      // strictly AFTER the assistant message is persisted and the terminal
      // frame is flushed to the spool.
      // Reading naturally pins that persistence-before-close ordering too,
      // rather than merely finding a `"finish"` substring and abandoning the
      // response body early.
      const streamRes = await fetch(
        url(a, `/api/${org}/decopilot/threads/${threadId}/stream`),
        { headers: jsonAuthHeaders() },
      );
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const text = await streamRes.text();

      const events = parseMessageEvents(text);
      expect(events.length).toBeGreaterThan(0);
      // First event mirrors the user's own turn back onto the stream (map
      // §3.2: "other viewers see it live").
      expect(events[0]?.type).toBe("data-user-message");
      expect(events.some((e) => e.type === "text-delta")).toBe(true);
      expect(events.some((e) => e.type === "finish")).toBe(true);

      // The user AND assistant messages must be persisted, reachable via
      // the SAME interception layer's own message-list tool.
      const messagesRes = await fetch(
        url(a, `/api/${org}/tools/COLLECTION_THREAD_MESSAGES_LIST`),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ thread_id: threadId }),
        },
      );
      const messages = (await messagesRes.json()) as {
        items: { role: string; parts: unknown }[];
      };
      expect(messages.items.map((m) => m.role)).toEqual(["user", "assistant"]);
      // Regression coverage for a bug found live against the real UI (Gate
      // C drive): the user message's `parts` was the WHOLE incoming
      // message envelope (an object), not the bare AI-SDK parts array —
      // `COLLECTION_THREAD_MESSAGES_LIST` must always return `parts` as an
      // array for EVERY role, since the real chat UI calls `.some()`/
      // `.map()` on it unconditionally and crashes (`n.parts?.some is not
      // a function`) the instant it isn't.
      for (const item of messages.items) {
        expect(Array.isArray(item.parts)).toBe(true);
      }
      const userItem = messages.items.find((m) => m.role === "user") as {
        parts: { type: string; text: string }[];
      };
      expect(userItem.parts).toEqual([
        { type: "text", text: "SCENARIO:simple" },
      ]);
    }, 15_000);

    it("cancel is idempotent and 202s even for a thread that was never dispatched", async () => {
      const org = freshOrg();
      const res = await fetch(
        url(a, `/api/${org}/decopilot/cancel/never-dispatched`),
        { method: "POST", headers: jsonAuthHeaders() },
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { cancelled: boolean };
      expect(body.cancelled).toBe(true);
    });

    it("serializes two turns FIFO, hides the queued user until promotion, and dedupes completed retries", async () => {
      const org = freshOrg();
      const threadId = `queued-${org}`;
      const firstId = `message-${org}-first`;
      const secondId = `message-${org}-second`;
      const dispatch = (id: string, text: string) =>
        fetch(url(a, `/api/${org}/decopilot/threads/${threadId}/messages`), {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({
            messages: [{ id, role: "user", parts: [{ type: "text", text }] }],
            harnessId: "claude-code",
            tier: "smart",
            mode: "default",
            toolApprovalLevel: "auto",
          }),
        });
      const listMessages = async () => {
        const res = await fetch(
          url(a, `/api/${org}/tools/COLLECTION_THREAD_MESSAGES_LIST`),
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({ thread_id: threadId, limit: 100 }),
          },
        );
        expect(res.status).toBe(200);
        return (await res.json()) as {
          items: { id: string; role: string }[];
        };
      };

      expect((await dispatch(firstId, "SCENARIO:slow:500")).status).toBe(202);
      expect((await dispatch(secondId, "SCENARIO:simple")).status).toBe(202);

      const listRes = await fetch(
        url(a, `/api/${org}/decopilot/queue/${threadId}`),
        { headers: jsonAuthHeaders() },
      );
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({
        items: [
          {
            workflowId: `thread-run:${threadId}:${firstId}`,
            messageId: firstId,
            status: "running",
            enqueuedAt: expect.any(Number),
            source: "user-message",
            text: "SCENARIO:slow:500",
            hasAttachments: false,
          },
          {
            workflowId: `thread-run:${threadId}:${secondId}`,
            messageId: secondId,
            status: "queued",
            enqueuedAt: expect.any(Number),
            source: "user-message",
            text: "SCENARIO:simple",
            hasAttachments: false,
          },
        ],
      });

      const whileFirstRuns = await retry(
        async () => {
          const body = await listMessages();
          if (!body.items.some((item) => item.id === firstId)) {
            throw new Error("first user row not persisted yet");
          }
          return body;
        },
        { maxAttempts: 20, minTimeout: 20, maxTimeout: 100, jitter: 0 },
      );
      expect(whileFirstRuns.items.map((item) => item.id)).not.toContain(
        secondId,
      );

      const firstStream = await fetch(
        url(a, `/api/${org}/decopilot/threads/${threadId}/stream`),
        { headers: jsonAuthHeaders() },
      );
      const firstEvents = parseMessageEvents(await firstStream.text());
      expect(
        firstEvents.some(
          (event) =>
            event.type === "data-user-message" &&
            (event.data as { id?: string } | undefined)?.id === firstId,
        ),
      ).toBe(true);
      expect(
        firstEvents.some(
          (event) =>
            event.type === "data-user-message" &&
            (event.data as { id?: string } | undefined)?.id === secondId,
        ),
      ).toBe(false);

      // Reconnect after run 1: old-stream cleanup must not delete run 2's
      // replay slot, even if run 2 completed before this GET arrives.
      const secondStream = await fetch(
        url(a, `/api/${org}/decopilot/threads/${threadId}/stream`),
        { headers: jsonAuthHeaders() },
      );
      const secondEvents = parseMessageEvents(await secondStream.text());
      expect(
        secondEvents.some(
          (event) =>
            event.type === "data-user-message" &&
            (event.data as { id?: string } | undefined)?.id === secondId,
        ),
      ).toBe(true);

      const completed = await retry(
        async () => {
          const body = await listMessages();
          if (body.items.length !== 4) {
            throw new Error(
              `expected 4 persisted rows, got ${body.items.length}`,
            );
          }
          return body;
        },
        { maxAttempts: 20, minTimeout: 20, maxTimeout: 100, jitter: 0 },
      );
      expect(completed.items.map((item) => item.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);

      // Same completed message id is a network retry, not a third run.
      expect((await dispatch(secondId, "SCENARIO:simple")).status).toBe(202);
      const afterRetry = await listMessages();
      expect(afterRetry.items).toHaveLength(4);
      const drainedRes = await fetch(
        url(a, `/api/${org}/decopilot/queue/${threadId}`),
        { headers: jsonAuthHeaders() },
      );
      expect(await drainedRes.json()).toEqual({ items: [] });
    }, 15_000);

    it("queue cancel removes a queued turn and cancels an active head", async () => {
      const org = freshOrg();
      const threadId = `cancel-queue-${org}`;
      const firstId = `message-${org}-hang`;
      const secondId = `message-${org}-queued`;
      const dispatch = (id: string, text: string) =>
        fetch(url(a, `/api/${org}/decopilot/threads/${threadId}/messages`), {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({
            messages: [{ id, role: "user", parts: [{ type: "text", text }] }],
            harnessId: "claude-code",
          }),
        });
      expect((await dispatch(firstId, "SCENARIO:hang")).status).toBe(202);
      expect((await dispatch(secondId, "SCENARIO:simple")).status).toBe(202);

      const cancelRes = await fetch(
        url(
          a,
          `/api/${org}/decopilot/queue/${threadId}/cancel/${encodeURIComponent(`thread-run:${threadId}:${secondId}`)}`,
        ),
        { method: "POST", headers: jsonAuthHeaders() },
      );
      expect(cancelRes.status).toBe(202);
      expect(await cancelRes.json()).toEqual({ cancelled: true });

      const listRes = await fetch(
        url(a, `/api/${org}/decopilot/queue/${threadId}`),
        { headers: jsonAuthHeaders() },
      );
      const listed = (await listRes.json()) as {
        items: { messageId: string; status: string }[];
      };
      expect(listed.items).toEqual([
        expect.objectContaining({ messageId: firstId, status: "running" }),
      ]);

      const cancelHeadRes = await fetch(
        url(
          a,
          `/api/${org}/decopilot/queue/${threadId}/cancel/${encodeURIComponent(`thread-run:${threadId}:${firstId}`)}`,
        ),
        { method: "POST", headers: jsonAuthHeaders() },
      );
      expect(cancelHeadRes.status).toBe(202);

      await retry(
        async () => {
          const res = await fetch(
            url(a, `/api/${org}/decopilot/queue/${threadId}`),
            { headers: jsonAuthHeaders() },
          );
          const body = (await res.json()) as { items: unknown[] };
          if (body.items.length !== 0) throw new Error("queue not drained yet");
        },
        { maxAttempts: 30, minTimeout: 20, maxTimeout: 100, jitter: 0 },
      );

      const messagesRes = await fetch(
        url(a, `/api/${org}/tools/COLLECTION_THREAD_MESSAGES_LIST`),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ thread_id: threadId, limit: 100 }),
        },
      );
      const messages = (await messagesRes.json()) as {
        items: { id: string }[];
      };
      expect(messages.items.map((item) => item.id)).not.toContain(secondId);
    }, 15_000);

    it("an unrecognized /decopilot/* subpath 404s locally and is NEVER forwarded upstream (the 100%-intercepted backstop)", async () => {
      const org = freshOrg();
      const res = await fetch(
        url(a, `/api/${org}/decopilot/some-future-route`),
        { headers: jsonAuthHeaders() },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      // Not the ordinary upstream-proxy 401/502 shape — proves this never
      // even attempted to reach upstream (no session is configured in this
      // suite at all; a forwarded request would 401 with `upstream:true`,
      // not 404 locally).
      expect(body.error).toContain("decopilot");
    });

    it("GET stream holds open (200, SSE) for a thread that was never dispatched, not 204", async () => {
      // Inverted from this test's old name/assertion ("GET stream is 204 for
      // a thread that was never dispatched"): the real client's
      // `runSseLoop` (thread-connection.ts) treats 204 as terminal —
      // "nothing will ever arrive here, stop reconnecting" — which is only
      // correct for the real backend's degraded-JetStream case, not an
      // ordinary idle thread awaiting its first dispatch. Found live driving
      // the real UI end-to-end (Gate C step 3: a message sent into a
      // freshly-landed thread never rendered its reply until a manual
      // reload). See `decopilot.rs`'s `DecopilotRun` "Idle placeholder" doc
      // section.
      const org = freshOrg();
      // `fetch()` resolves once headers arrive, before the (never-ending
      // until a dispatch lands) body is read — abort in `finally` rather
      // than reading it, exactly the hazard `readSseUntil`'s own doc
      // comment calls out ("a stream that emits no bytes and never closes"
      // must be bounded, not left open).
      const ctrl = new AbortController();
      try {
        const res = await fetch(
          url(a, `/api/${org}/decopilot/threads/never-dispatched/stream`),
          { headers: jsonAuthHeaders(), signal: ctrl.signal },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
      } finally {
        ctrl.abort();
      }
    });
  },
);

/** A signature-less JWT shaped id_token — mirrors
 *  `upstream-auth-proxy.e2e.test.ts`'s `fakeIdToken` helper (module-private
 *  there; a black-box e2e file owning its own minimal contract fixture is
 *  correct per this repo's e2e philosophy, not duplication — see
 *  TESTING.md / CLAUDE.md's e2e-isolation section). `decode_id_token`
 *  (Rust side) never verifies the signature. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

const ATTRIB_SESSION_COOKIE = "better-auth.session_token=attrib-session";

/** Minimal Better-Auth-shaped stub — just enough of the sign-in +
 *  MCP-authorize + token-exchange dance for `auth_complete_session` to
 *  succeed, so a REAL signed-in user id lands in `upstream::global()`. */
function startAttribStubMesh() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/auth/sign-in/email" && req.method === "POST") {
        return new Response(
          JSON.stringify({ user: { id: "stub-attrib-user" } }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": `${ATTRIB_SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
            },
          },
        );
      }
      if (u.pathname === "/api/auth/mcp/register" && req.method === "POST") {
        return Response.json({ client_id: "attrib-client-id" });
      }
      if (u.pathname === "/api/auth/mcp/authorize" && req.method === "GET") {
        if (req.headers.get("cookie") !== ATTRIB_SESSION_COOKIE) {
          return new Response("no session", { status: 401 });
        }
        const redirectUri = u.searchParams.get("redirect_uri")!;
        const state = u.searchParams.get("state") ?? "";
        const target = new URL(redirectUri);
        target.searchParams.set("code", "attrib-auth-code");
        target.searchParams.set("state", state);
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }
      if (u.pathname === "/api/auth/mcp/token" && req.method === "POST") {
        const idToken = fakeIdToken({
          sub: "stub-attrib-user",
          email: "attrib@example.test",
          name: "Attrib User",
        });
        return Response.json({
          access_token: "attrib-access-token",
          refresh_token: "attrib-refresh-token",
          expires_in: 3600,
          id_token: idToken,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://localhost:${server.port}` };
}

/** Establish the same identity path the native UI uses: credentials enter via
 * Better Auth's public route, then the public completion bridge performs MCP
 * OAuth and installs the resulting session in the local API. */
async function signInAndCompleteSession(a: LocalApi): Promise<void> {
  const signIn = await fetch(url(a, "/api/auth/sign-in/email"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      email: "attrib@example.test",
      password: "hunter2",
    }),
  });
  expect(signIn.status).toBe(200);

  const bridge = await fetch(url(a, "/_auth/complete-session"), {
    method: "POST",
    headers: authHeaders(),
  });
  expect(bridge.status).toBe(200);
}

// Regression coverage for a bug found live against the real UI (Gate C
// drive): the production chat input (`components/chat/input.tsx`) renders
// permanently READ-ONLY ("viewing someone else's chat") whenever
// `task.created_by !== ` the real signed-in `userId` — so any
// locally-stamped `created_by` that ISN'T the actual signed-in user's id
// breaks the entire desktop chat surface, not just an edge case. Each test
// here gets its own process AND its own never-before-seen upstream host
// (a fresh `Bun.serve({port:0})`), so a real Keychain entry from an
// earlier run/process can never make either assertion flaky.
describeLocalApi(
  "local-api e2e: real-UI interception — thread attribution reflects the real signed-in user",
  () => {
    let a: LocalApi | null = null;
    let stub: ReturnType<typeof startAttribStubMesh> | null = null;

    afterEach(async () => {
      await stopLocalApi(a);
      a = null;
      stub?.server.stop(true);
      stub = null;
    }, HOOK_TIMEOUT_MS);

    it(
      "COLLECTION_THREADS_CREATE stamps created_by with the signed-in user's real id, not a placeholder",
      async () => {
        stub = startAttribStubMesh();
        a = await startLocalApi({
          DECOCMS_UPSTREAM_URL: stub.url,
          LOCAL_API_TOKEN_STORE: "memory",
        });
        await signInAndCompleteSession(a);

        const createRes = await fetch(
          url(a, "/api/attrib-org/tools/COLLECTION_THREADS_CREATE"),
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({ data: { title: "t", virtual_mcp_id: "v" } }),
          },
        );
        expect(createRes.status).toBe(200);
        const created = (await createRes.json()) as {
          item: Record<string, unknown>;
        };
        expect(created.item.created_by).toBe("stub-attrib-user");
      },
      HOOK_TIMEOUT_MS,
    );

    it(
      "rejects account-scoped thread creation while signed out and persists no row",
      async () => {
        // No sign-in/bridge call at all — a fresh process, fresh never-used
        // host, so `current_user_sub()` resolves to `None` deterministically.
        stub = startAttribStubMesh();
        a = await startLocalApi({
          DECOCMS_UPSTREAM_URL: stub.url,
          LOCAL_API_TOKEN_STORE: "memory",
        });

        // LINK_CURRENT_GET is device capability discovery, not account data;
        // it intentionally remains usable before sign-in.
        const linkRes = await fetch(
          url(a, "/api/attrib-org-signed-out/tools/LINK_CURRENT_GET"),
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({}),
          },
        );
        expect(linkRes.status).toBe(200);
        expect(await linkRes.json()).toEqual({
          online: true,
          capabilities: expect.any(Array),
        });

        const threadId = "signed-out-create-must-not-exist";
        const createRes = await fetch(
          url(a, "/api/attrib-org-signed-out/tools/COLLECTION_THREADS_CREATE"),
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({
              data: { id: threadId, title: "t", virtual_mcp_id: "v" },
            }),
          },
        );
        expect(createRes.status).toBe(401);
        expect(await createRes.json()).toEqual({ error: "unauthorized" });

        // Authenticate through the public bridge, then prove the rejected
        // write did not leave a placeholder-owned or partially-created row.
        await signInAndCompleteSession(a);
        const getRes = await fetch(
          url(a, "/api/attrib-org-signed-out/tools/COLLECTION_THREADS_GET"),
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({ id: threadId }),
          },
        );
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual({ item: null });

        const listRes = await fetch(
          url(a, "/api/attrib-org-signed-out/tools/COLLECTION_THREADS_LIST"),
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({ limit: 50, offset: 0 }),
          },
        );
        expect(listRes.status).toBe(200);
        expect(await listRes.json()).toEqual({
          items: [],
          totalCount: 0,
          hasMore: false,
        });
      },
      HOOK_TIMEOUT_MS,
    );
  },
);
