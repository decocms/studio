/**
 * Tests for Decopilot route helpers.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "@/core/mesh-context";
import { computeIdempotencyKey, createDecopilotRoutes } from "./routes";
import type { CancelBroadcast } from "./cancel-broadcast";
import type { RunRegistry } from "./run-registry";
import type { StreamBuffer } from "./stream-buffer";
import type { ChatMessage } from "./types";

describe("computeIdempotencyKey", () => {
  test("returns undefined for no message", () => {
    expect(computeIdempotencyKey(undefined)).toBeUndefined();
  });

  test("user turn: returns the message id verbatim", () => {
    const msg = {
      id: "user-123",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(msg)).toBe("user-123");
  });

  test("assistant continuation: hashes the message contents", () => {
    const msg = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    const key = computeIdempotencyKey(msg);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  test("identical assistant messages produce the same hash (retry safety)", () => {
    const msg = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(msg)).toBe(computeIdempotencyKey(msg)!);
  });

  test("different approval states on the same message id produce different hashes", () => {
    // Regression: the previous implementation used `lastMsg.id` for both
    // branches, so two distinct approval rounds on the same assistant
    // message collapsed onto the first workflow and bricked the chat.
    const base = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    const next = {
      ...base,
      parts: [
        ...base.parts,
        {
          type: "tool-write",
          state: "approval-responded",
          approval: { id: "ap_2", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey(next));
  });

  test("user message without id falls back to content hash", () => {
    const msg = {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as ChatMessage;
    const key = computeIdempotencyKey(msg);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ============================================================================
// Stream Endpoint — pure live tail (no snapshot)
// ============================================================================

interface StreamTestSetup {
  app: Hono<{ Variables: { meshContext: MeshContext } }>;
  listMessagesCalls: number;
}

function makeStreamApp(opts: {
  threadStatus?: "idle" | "in_progress";
  tailChunks?: ReadableStream | null;
}): StreamTestSetup {
  let listMessagesCalls = 0;

  const ctx = {
    organization: { id: "org_1", slug: "acme" },
    auth: { user: { id: "user_1" } },
    storage: {
      threads: {
        get: async () => ({
          id: "thread_1",
          organization_id: "org_1",
          status: opts.threadStatus ?? "idle",
          created_by: "user_1",
        }),
        listMessages: async () => {
          listMessagesCalls += 1;
          return { messages: [], total: 0 };
        },
      },
    },
  } as unknown as MeshContext;

  const tail =
    opts.tailChunks === undefined
      ? new ReadableStream({
          start(controller) {
            controller.close();
          },
        })
      : opts.tailChunks;

  const streamBuffer = {
    init: async () => {},
    pump: () => {},
    purge: () => {},
    teardown: () => {},
    createTailStream: async () => tail,
  } as unknown as StreamBuffer;

  const cancelBroadcast = {
    broadcast: () => {},
  } as unknown as CancelBroadcast;
  const runRegistry = {} as unknown as RunRegistry;

  const app = new Hono<{ Variables: { meshContext: MeshContext } }>();
  app.use("*", async (c, next) => {
    c.set("meshContext", ctx);
    await next();
  });
  app.route(
    "/",
    createDecopilotRoutes({ cancelBroadcast, streamBuffer, runRegistry }),
  );

  return {
    app,
    get listMessagesCalls() {
      return listMessagesCalls;
    },
  };
}

async function readSseBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  buf += decoder.decode();
  return buf;
}

describe("GET /:org/decopilot/threads/:threadId/stream", () => {
  test("does not call listMessages or emit a snapshot frame", async () => {
    const setup = makeStreamApp({});

    const res = await setup.app.request(
      "/acme/decopilot/threads/thread_1/stream",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await readSseBody(res);

    // No snapshot frame anywhere in the response — the client owns initial
    // load via COLLECTION_THREAD_MESSAGES_LIST.
    expect(body).not.toContain("event: snapshot");

    // Handler never touches storage.threads.listMessages.
    expect(setup.listMessagesCalls).toBe(0);
  });

  test("forwards tail chunks from streamBuffer with no preceding snapshot", async () => {
    const tail = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.close();
      },
    });
    const setup = makeStreamApp({ tailChunks: tail });

    const res = await setup.app.request(
      "/acme/decopilot/threads/thread_1/stream",
    );
    expect(res.status).toBe(200);

    const body = await readSseBody(res);
    expect(body).not.toContain("event: snapshot");
    expect(body).toContain('"type":"start"');
  });
});
