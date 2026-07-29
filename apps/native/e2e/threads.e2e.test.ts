/**
 * local-api e2e: threads CRUD lifecycle.
 *
 * New surface, no daemon precedent — see
 * the native local-API contract. Local
 * SQLite only; nothing here talks to `/upstream/*`.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  createThread,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  type ThreadWire,
  url,
} from "./helpers";

describeLocalApi("local-api e2e: threads", () => {
  let a: LocalApi;
  beforeAll(async () => {
    a = await startLocalApi();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
  }, HOOK_TIMEOUT_MS);

  it("GET /threads on a fresh instance returns an empty list", async () => {
    const res = await fetch(url(a, "/threads"), {
      headers: jsonAuthHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: ThreadWire[] };
    expect(body.threads).toEqual([]);
  });

  it("POST /threads with no body defaults title to an empty string", async () => {
    const res = await fetch(url(a, "/threads"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: ThreadWire };
    expect(body.thread.title).toBe("");
    expect(typeof body.thread.id).toBe("string");
    expect(body.thread.id.length).toBeGreaterThan(0);
    expect(typeof body.thread.created_at).toBe("string");
    expect(body.thread.updated_at).toBe(body.thread.created_at);
  });

  it("full lifecycle: create → list → get → patch → message → runs → delete", async () => {
    const created = await createThread(a, "hello world");
    expect(created.title).toBe("hello world");

    // list includes it
    const listRes = await fetch(url(a, "/threads"), {
      headers: jsonAuthHeaders(),
    });
    const listBody = (await listRes.json()) as { threads: ThreadWire[] };
    expect(listBody.threads.some((t) => t.id === created.id)).toBe(true);

    // get by id
    const getRes = await fetch(url(a, `/threads/${created.id}`), {
      headers: jsonAuthHeaders(),
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { thread: ThreadWire };
    expect(getBody.thread).toEqual(created);

    // patch title
    const patchRes = await fetch(url(a, `/threads/${created.id}`), {
      method: "PATCH",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ title: "renamed" }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { thread: ThreadWire };
    expect(patchBody.thread.title).toBe("renamed");
    expect(patchBody.thread.updated_at >= created.updated_at).toBe(true);

    // append a message
    const msgRes = await fetch(url(a, `/threads/${created.id}/messages`), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      }),
    });
    expect(msgRes.status).toBe(201);
    const msgBody = (await msgRes.json()) as {
      message: {
        id: string;
        thread_id: string;
        role: string;
        parts: unknown[];
        created_at: string;
      };
    };
    expect(msgBody.message.thread_id).toBe(created.id);
    expect(msgBody.message.role).toBe("user");
    expect(msgBody.message.parts).toEqual([{ type: "text", text: "hi" }]);

    // list messages
    const messagesRes = await fetch(url(a, `/threads/${created.id}/messages`), {
      headers: jsonAuthHeaders(),
    });
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as {
      messages: unknown[];
    };
    expect(messagesBody.messages.length).toBe(1);

    // runs start empty (no dispatch was issued for this thread)
    const runsRes = await fetch(url(a, `/threads/${created.id}/runs`), {
      headers: jsonAuthHeaders(),
    });
    expect(runsRes.status).toBe(200);
    const runsBody = (await runsRes.json()) as { runs: unknown[] };
    expect(runsBody.runs).toEqual([]);

    // delete, then confirm gone
    const delRes = await fetch(url(a, `/threads/${created.id}`), {
      method: "DELETE",
      headers: jsonAuthHeaders(),
    });
    expect(delRes.status).toBe(204);

    const goneRes = await fetch(url(a, `/threads/${created.id}`), {
      headers: jsonAuthHeaders(),
    });
    expect(goneRes.status).toBe(404);
  });

  it("DELETE on an already-deleted thread is idempotent (204)", async () => {
    const t = await createThread(a, "to be deleted twice");
    const first = await fetch(url(a, `/threads/${t.id}`), {
      method: "DELETE",
      headers: jsonAuthHeaders(),
    });
    expect(first.status).toBe(204);
    const second = await fetch(url(a, `/threads/${t.id}`), {
      method: "DELETE",
      headers: jsonAuthHeaders(),
    });
    expect(second.status).toBe(204);
  });

  it("GET /threads/:id for an unknown id → 404", async () => {
    const res = await fetch(url(a, "/threads/does-not-exist"), {
      headers: jsonAuthHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("POST /threads/:id/messages with an invalid role → 400", async () => {
    const t = await createThread(a);
    const res = await fetch(url(a, `/threads/${t.id}/messages`), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ role: "not-a-role", parts: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /threads/:id/messages for an unknown thread → 404", async () => {
    const res = await fetch(url(a, "/threads/does-not-exist/messages"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ role: "user", parts: [] }),
    });
    expect(res.status).toBe(404);
  });
});
