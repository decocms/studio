import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { UIMessageChunk } from "ai";
import type { SSEEvent } from "@/event-bus";
import type { ThreadMessagePart } from "@/storage/fold-parts";
import type { Env } from "../../hono-env";
import {
  createLinkIngestRoutes,
  ndjsonLines,
  NdjsonLineTooLargeError,
  RELAY_NDJSON_MAX_LINE_BYTES,
} from "./link-ingest-routes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN_ID = "run_1";

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    organization_id: "org_1",
    status: "in_progress",
    virtual_mcp_id: "vmcp_1",
    created_by: "user_1",
    trigger_id: null,
    title: "Test thread",
    branch: null,
    message_storage_version: 2,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:01.000Z",
    ...overrides,
  };
}

interface AppContextOptions {
  /** Thread row returned by storage.threads.get (null = missing). */
  thread?: Record<string, unknown> | null;
  cancelRequestedAt?: string | null;
  runFence?: string | null;
  authUserId?: string | null;
  orgId?: string;
  /** When true, createTailStream returns an instantly-closed stream so the
   *  pump path runs; when false (default) the tail is null → direct drain. */
  withTail?: boolean;
  ackedSeq?: number;
}

function appWithContext(opts: AppContextOptions = {}) {
  const thread = opts.thread === undefined ? makeThread() : opts.thread;
  const appended: ThreadMessagePart[][] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const purged: string[] = [];
  const pumped: UIMessageChunk[][] = [];
  const publishedRaw: Array<{ chunk: unknown; msgId?: string }> = [];
  const publishedDone: Array<{ fenceToken: string; finalSeq: number }> = [];
  const pumpPromises: Promise<void>[] = [];
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const insertedIds = new Set<string>();
  let bumps = 0;
  let threadStatus =
    thread && typeof thread.status === "string" ? thread.status : "in_progress";
  let ackedSeq = opts.ackedSeq ?? 0;

  const threadRow = () => ({ ...thread, status: threadStatus });

  // Mutable DB-current fence so a test can simulate a NEW run minting a fresh
  // fence between two relay POSTs (fence-epoch supersede).
  let currentRunFence: string | null =
    opts.runFence === undefined ? "fence_1" : opts.runFence;

  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("meshContext", {
      auth:
        opts.authUserId === null
          ? {}
          : { user: { id: opts.authUserId ?? "user_1" } },
      organization: { id: opts.orgId ?? "org_1", slug: "acme" },
      storage: {
        threads: {
          get: async () => (thread ? threadRow() : null),
          getCancelRequestedAt: async () => opts.cancelRequestedAt ?? null,
          getRunFence: async () => currentRunFence,
          getAckedSeq: async () => ackedSeq,
          bumpAckedSeq: async (
            _runId: string,
            _fenceToken: string,
            seq: number,
          ) => {
            ackedSeq = Math.max(ackedSeq, seq);
          },
          bumpProgress: async () => {
            bumps++;
          },
          update: async (id: string, data: Record<string, unknown>) => {
            updates.push({ id, data });
            if (typeof data.status === "string") threadStatus = data.status;
            return threadRow();
          },
          completeRunIfNotCompleted: async () => {
            if (threadStatus !== "in_progress") return null;
            threadStatus = "completed";
            updates.push({
              id: RUN_ID,
              data: {
                status: "completed",
                run_owner_pod: null,
                run_config: null,
                run_started_at: null,
              },
            });
            return threadRow();
          },
          markRunFailed: async (_id: string, reason: string, kind: string) => {
            if (threadStatus !== "in_progress") return;
            threadStatus = "failed";
            updates.push({
              id: RUN_ID,
              data: {
                status: "failed",
                failure_reason: reason,
                failure_kind: kind,
              },
            });
          },
          messageParts: () => ({
            appendParts: async (rows: ThreadMessagePart[]) => {
              const inserted = rows.filter((row) => !insertedIds.has(row.id));
              for (const row of inserted) insertedIds.add(row.id);
              if (inserted.length > 0) appended.push(inserted);
              return inserted;
            },
            // The relay path now builds its assistant emitter via
            // createAssistantEmitter, which seeds the created_at base from the
            // run's existing parts. Nothing pre-exists in this stub → null.
            maxCreatedAtMsForRun: async () => null,
          }),
        },
      },
    } as unknown as Env["Variables"]["meshContext"]);
    await next();
  });

  app.route(
    "/api/:org",
    createLinkIngestRoutes({
      streamBuffer: {
        init: async () => undefined,
        publishRawChunk: async (
          _taskId: string,
          chunk: unknown,
          opts?: { msgId?: string },
        ) => {
          publishedRaw.push({ chunk, msgId: opts?.msgId });
          return true;
        },
        publishDone: async (
          _taskId: string,
          fenceToken: string,
          finalSeq: number,
        ) => {
          publishedDone.push({ fenceToken, finalSeq });
          return true;
        },
        publishCheckpoint: async () => true,
        pump: (stream: ReadableStream) => {
          const index = pumped.length;
          pumped.push([]);
          const promise = (async () => {
            const reader = stream.getReader();
            const chunks: UIMessageChunk[] = [];
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value as UIMessageChunk);
              }
            } finally {
              reader.releaseLock();
            }
            pumped[index] = chunks;
          })();
          pumpPromises.push(promise);
        },
        createTailStream: async () =>
          opts.withTail
            ? new ReadableStream({
                start(controller) {
                  controller.close();
                },
              })
            : null,
        purge: (taskId: string) => {
          purged.push(taskId);
        },
        teardown: () => undefined,
      },
      sseHub: {
        emit: (orgId: string, event: SSEEvent) => {
          sseEvents.push({ orgId, event });
        },
      },
    }),
  );

  return {
    app,
    appended,
    updates,
    purged,
    pumped,
    publishedRaw,
    publishedDone,
    pumpPromises,
    sseEvents,
    bumps: () => bumps,
    setRunFence: (token: string | null) => {
      currentRunFence = token;
    },
    ackedSeq: () => ackedSeq,
  };
}

// ---------------------------------------------------------------------------
// NDJSON relay body builders
// ---------------------------------------------------------------------------

type RelayEvent =
  | { type: "ui-message-chunk"; chunk: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

function relayBody(events: RelayEvent[], fromSeq = 1): string {
  return `${events
    .map((event, i) => JSON.stringify({ seq: fromSeq + i, event }))
    .join("\n")}\n`;
}

function chunkEvents(chunks: unknown[]): RelayEvent[] {
  return chunks.map((chunk) => ({ type: "ui-message-chunk", chunk }));
}

/** One complete assistant turn (text "hello") as UIMessageChunks. */
function helloTurnChunks(messageId = "msg_1"): unknown[] {
  const textId = `${messageId}-text-0`;
  return [
    { type: "start", messageId },
    { type: "start-step" },
    { type: "text-start", id: textId },
    { type: "text-delta", id: textId, delta: "hello" },
    { type: "text-end", id: textId },
    { type: "finish-step" },
    { type: "finish" },
  ];
}

function postChunks(
  app: Hono<Env>,
  body: string,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/acme/links/runs/${RUN_ID}/chunks`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      "x-fence-token": "fence_1",
      "x-relay-from": "1",
      ...headers,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// ndjsonLines
// ---------------------------------------------------------------------------

function bytesStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iter) out.push(value);
  return out;
}

describe("ndjsonLines", () => {
  test("yields one parsed value per line, skipping blank lines", async () => {
    const lines = await collect(
      ndjsonLines(bytesStream(['{"a":1}\n', "\n", '{"b":2}\n'])),
    );
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("reassembles lines split across byte chunks", async () => {
    const lines = await collect(
      ndjsonLines(bytesStream(['{"seq":1,"ev', 'ent":{"type":"done"}}\n'])),
    );
    expect(lines).toEqual([{ seq: 1, event: { type: "done" } }]);
  });

  test("parses a trailing line without a final newline", async () => {
    const lines = await collect(ndjsonLines(bytesStream(['{"a":1}\n{"b":2}'])));
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("throws SyntaxError on malformed JSON", async () => {
    await expect(
      collect(ndjsonLines(bytesStream(["not json\n"]))),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  test("throws NdjsonLineTooLargeError when a pending line exceeds the cap", async () => {
    // No newline ever arrives — the buffer grows past the (tiny) cap.
    await expect(
      collect(ndjsonLines(bytesStream(["aaaa", "bbbb", "cccc"]), 8)),
    ).rejects.toBeInstanceOf(NdjsonLineTooLargeError);
  });

  test("throws NdjsonLineTooLargeError for an over-cap trailing line", async () => {
    await expect(
      collect(ndjsonLines(bytesStream(["123456789"]), 8)),
    ).rejects.toBeInstanceOf(NdjsonLineTooLargeError);
  });

  test("does not trip the cap when lines stay under it", async () => {
    const lines = await collect(
      ndjsonLines(bytesStream(['{"a":1}\n', '{"b":2}\n']), 16),
    );
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("default line cap is 1 MiB", () => {
    expect(RELAY_NDJSON_MAX_LINE_BYTES).toBe(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// POST /links/runs/:runId/chunks
// ---------------------------------------------------------------------------

describe("link ingest chunks route", () => {
  test("rejects unauthenticated callers with 401", async () => {
    const { app } = appWithContext({ authUserId: null });

    const res = await postChunks(app, relayBody([{ type: "done" }]));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("404s a missing thread before any fence handling", async () => {
    const { app } = appWithContext({ thread: null });

    const res = await postChunks(app, relayBody([{ type: "done" }]));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("404s a thread owned by a foreign org", async () => {
    const { app } = appWithContext({
      thread: makeThread({ organization_id: "org_other" }),
    });

    const res = await postChunks(app, relayBody([{ type: "done" }]));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("rejects cancelled runs with 409 even on a valid fence", async () => {
    const { app } = appWithContext({
      cancelRequestedAt: "2026-06-09T00:00:00.000Z",
    });

    const res = await postChunks(app, relayBody([{ type: "done" }]));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cancelled" });
  });

  test("rejects a missing fence with 409", async () => {
    const { app } = appWithContext({ runFence: null });

    const res = await postChunks(app, relayBody([{ type: "done" }]));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no active run fence" });
  });

  test("rejects a stale fence token with 409", async () => {
    const { app, appended } = appWithContext();

    const res = await postChunks(app, relayBody([{ type: "done" }]), {
      "x-fence-token": "wrong_fence",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "fenced" });
    expect(appended).toEqual([]);
  });

  test("a resumed relay is accepted without pod-local session state", async () => {
    const { app } = appWithContext();

    // x-relay-from is informational for the NDJSON path. The daemon's
    // full-prefix resend is idempotent (§10), so any pod can accept it.
    const res = await postChunks(app, relayBody([{ type: "done" }], 5), {
      "x-relay-from": "5",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastSeq: 5 });
  });

  test("400 bad line for a schema-invalid relay line", async () => {
    const { app } = appWithContext();

    const res = await postChunks(
      app,
      '{"seq":"one","event":{"type":"done"}}\n',
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad line" });
  });

  test("400 bad line for malformed NDJSON", async () => {
    const { app } = appWithContext();

    const res = await postChunks(app, "not json at all\n");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad line" });
  });

  test("rejects a relay POST that ends without a terminal line instead of parking pod-local state", async () => {
    const { app, publishedDone } = appWithContext();

    const res = await postChunks(
      app,
      relayBody(chunkEvents(helloTurnChunks().slice(0, 2))),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing terminal relay line" });
    expect(publishedDone).toEqual([]);
  });

  test("publishes seq-keyed RAW chunks AND persists the assistant message + completed status inline", async () => {
    const { app, appended, updates, publishedRaw, pumped } = appWithContext();

    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];
    const res = await postChunks(app, relayBody(events));
    expect(res.status).toBe(200);

    // Every relayed ui-message-chunk was published RAW, in wire order, with no
    // fold/interception (the daemon's raw harness output IS the NATS source).
    const types = publishedRaw.map((c) => (c.chunk as { type: string }).type);
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    // Each chunk carries a seq-keyed `Nats-Msg-Id` (`runId:fence:seq`) so the
    // projector + JetStream dedup a resend. Seqs are contiguous from 1.
    expect(publishedRaw.map((c) => c.msgId)).toEqual([
      `${RUN_ID}:fence_1:1`,
      `${RUN_ID}:fence_1:2`,
      `${RUN_ID}:fence_1:3`,
      `${RUN_ID}:fence_1:4`,
      `${RUN_ID}:fence_1:5`,
      `${RUN_ID}:fence_1:6`,
      `${RUN_ID}:fence_1:7`,
    ]);
    // The processed uiStream is NOT pumped to NATS in this mode; raw relay
    // chunks are already the durable source.
    expect(pumped).toHaveLength(0);

    // The assistant message is persisted INLINE (v2) so a reload right after
    // the relay POST sees it — no waiting on the async projector. At least one
    // content part plus a finish anchor landed.
    const flatRows = appended.flat();
    expect(flatRows.some((r) => r.kind === "text")).toBe(true);
    expect(flatRows.some((r) => r.kind === "finish")).toBe(true);
    // And the durable status flips to completed at stream end (no RunRegistry
    // on this pod — written directly, idempotent).
    expect(updates.some((u) => u.data.status === "completed")).toBe(true);
  });

  test("uses durable ack floor to skip a replayed prefix when a retry lands on another pod", async () => {
    const { app, publishedRaw, publishedDone, ackedSeq } = appWithContext({
      ackedSeq: 3,
    });

    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];
    const res = await postChunks(app, relayBody(events), {
      "x-relay-from": "1",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastSeq: 8 });
    expect(publishedRaw.map((c) => c.msgId)).toEqual([
      `${RUN_ID}:fence_1:4`,
      `${RUN_ID}:fence_1:5`,
      `${RUN_ID}:fence_1:6`,
      `${RUN_ID}:fence_1:7`,
    ]);
    expect(publishedDone).toEqual([{ fenceToken: "fence_1", finalSeq: 7 }]);
    expect(ackedSeq()).toBe(7);
  });

  test("an error relay line publishes an `error` chunk + the {done} marker so the projector can fail the run", async () => {
    const { app, appended, updates, publishedRaw, publishedDone, sseEvents } =
      appWithContext();

    // A turn that streams partial text and then fails with an error EVENT
    // (no `done` line — the error is the terminator), exactly like
    // buildErrorRelayBody in the e2e fixtures.
    const events: RelayEvent[] = [
      { type: "ui-message-chunk", chunk: { type: "start", messageId: "m1" } },
      { type: "ui-message-chunk", chunk: { type: "start-step" } },
      {
        type: "ui-message-chunk",
        chunk: { type: "text-start", id: "m1-text-0" },
      },
      {
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "m1-text-0", delta: "partial" },
      },
      {
        type: "ui-message-chunk",
        chunk: { type: "text-end", id: "m1-text-0" },
      },
      { type: "error", code: "harness_error", message: "simulated failure" },
    ];
    const res = await postChunks(app, relayBody(events));
    expect(res.status).toBe(200);

    // The harness error EVENT is routed in-band as a published AI-SDK `error`
    // chunk so the durable projector reconstructs it (and the kernel's onError
    // persists an error + finish part on re-projection).
    const types = publishedRaw.map((c) => (c.chunk as { type: string }).type);
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "error",
    ]);
    const errorChunk = publishedRaw.find(
      (c) => (c.chunk as { type: string }).type === "error",
    );
    expect((errorChunk!.chunk as { errorText?: string }).errorText).toContain(
      "simulated failure",
    );

    // The {done} marker IS published (fence-scoped, finalSeq = last seq) — this
    // is what schedules the durable projector. A thrown source would skip it.
    expect(publishedDone).toEqual([{ fenceToken: "fence_1", finalSeq: 6 }]);

    // The error is persisted INLINE (kernel onError → emitError) so a reload
    // sees the failed message: an `error` part + a finish anchor.
    const flatRows = appended.flat();
    expect(flatRows.some((r) => r.kind === "error")).toBe(true);
    expect(flatRows.some((r) => r.kind === "finish")).toBe(true);
    // And the durable status flips to failed inline (with reason/kind), not
    // only via the projector backstop.
    expect(
      updates.some(
        (u) => u.data.status === "failed" && u.data.failure_kind === "harness",
      ),
    ).toBe(true);

    // Live failure SSE still fires (kernel onError ran on the error chunk).
    const finishFailed = sseEvents.some(
      (e) =>
        (e.event as { type?: string; data?: { status?: string } }).data
          ?.status === "failed",
    );
    expect(finishFailed).toBe(true);
  });

  test("400 line too large when a relay NDJSON line exceeds the cap", async () => {
    const { app } = appWithContext();
    // A single line with no newline, well over the 1 MiB cap.
    const huge = `{"seq":1,"event":{"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"t","delta":"${"x".repeat(
      1024 * 1024 + 16,
    )}"}}}`;
    const res = await postChunks(app, huge);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "line too large" });
  });
});
