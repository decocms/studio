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
// Stream Endpoint — snapshot event on connect
// ============================================================================

interface StreamTestSetup {
  app: Hono<{ Variables: { meshContext: MeshContext } }>;
  listMessagesCalls: number;
}

function makeStreamApp(opts: {
  messages: Array<Record<string, unknown>>;
  threadStatus?: "idle" | "in_progress";
  tailChunks?: ReadableStream | null;
}): StreamTestSetup {
  let listMessagesCalls = 0;
  const messages = opts.messages;

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
          return { messages, total: messages.length };
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
  test("emits a snapshot SSE event before any other frames", async () => {
    const messages = [
      {
        id: "msg_1",
        thread_id: "thread_1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "msg_2",
        thread_id: "thread_1",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
        created_at: "2026-01-01T00:00:01.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
    ];
    const setup = makeStreamApp({ messages });

    const res = await setup.app.request(
      "/acme/decopilot/threads/thread_1/stream",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await readSseBody(res);

    // The snapshot frame must come first (modulo keepalive comments).
    const snapshotIdx = body.indexOf("event: snapshot");
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);

    // Nothing other than keepalive comments may precede the snapshot frame.
    const prefix = body.slice(0, snapshotIdx);
    for (const line of prefix.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      throw new Error(
        `unexpected non-comment SSE line before snapshot: ${JSON.stringify(line)}`,
      );
    }

    // The snapshot data line should parse to { messages: [...] }
    const afterEvent = body.slice(snapshotIdx);
    const dataMatch = afterEvent.match(/^data: (.*)$/m);
    expect(dataMatch).not.toBeNull();
    const dataJson = dataMatch?.[1] ?? "";
    const parsed = JSON.parse(dataJson) as { messages: unknown[] };
    expect(parsed.messages).toHaveLength(2);
    expect((parsed.messages[0] as { id: string }).id).toBe("msg_1");
    expect((parsed.messages[1] as { id: string }).id).toBe("msg_2");
  });

  test("emits a snapshot SSE event even when the thread has no messages", async () => {
    const setup = makeStreamApp({ messages: [] });

    const res = await setup.app.request(
      "/acme/decopilot/threads/thread_1/stream",
    );
    expect(res.status).toBe(200);

    const body = await readSseBody(res);
    expect(body).toContain("event: snapshot");
    const m = body.match(/event: snapshot\ndata: (.*)\n/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m?.[1] ?? "")).toEqual({ messages: [] });
  });

  test("snapshot precedes tail chunks from streamBuffer", async () => {
    const messages = [
      {
        id: "msg_1",
        thread_id: "thread_1",
        role: "user",
        parts: [{ type: "text", text: "ping" }],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];

    // The tail emits a UI message chunk (which the AI SDK serializes to
    // `data: {...}\n\n`). The snapshot frame must come strictly before it.
    const tail = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.close();
      },
    });

    const setup = makeStreamApp({ messages, tailChunks: tail });

    const res = await setup.app.request(
      "/acme/decopilot/threads/thread_1/stream",
    );
    expect(res.status).toBe(200);

    const body = await readSseBody(res);
    const snapshotIdx = body.indexOf("event: snapshot");
    const tailIdx = body.indexOf('"type":"start"');
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    expect(tailIdx).toBeGreaterThan(snapshotIdx);
  });
});
