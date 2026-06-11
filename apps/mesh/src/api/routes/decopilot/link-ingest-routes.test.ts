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
  /** Flip the ingest to publish-then-consume (raw chunks → NATS) instead of
   *  pumping the processed uiStream. Default false (legacy pump path). */
  publishThenConsume?: boolean;
}

function appWithContext(opts: AppContextOptions = {}) {
  const thread = opts.thread === undefined ? makeThread() : opts.thread;
  const appended: ThreadMessagePart[][] = [];
  const savedMessages: unknown[][] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const purged: string[] = [];
  const pumped: UIMessageChunk[][] = [];
  const publishedRaw: unknown[] = [];
  const pumpPromises: Promise<void>[] = [];
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const insertedIds = new Set<string>();
  let bumps = 0;
  let threadStatus =
    thread && typeof thread.status === "string" ? thread.status : "in_progress";

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
          saveMessages: async (messages: unknown[]) => {
            savedMessages.push(messages);
          },
          messageParts: () => ({
            appendParts: async (rows: ThreadMessagePart[]) => {
              const inserted = rows.filter((row) => !insertedIds.has(row.id));
              for (const row of inserted) insertedIds.add(row.id);
              if (inserted.length > 0) appended.push(inserted);
              return inserted;
            },
          }),
        },
      },
    } as unknown as Env["Variables"]["meshContext"]);
    await next();
  });

  app.route(
    "/api/:org",
    createLinkIngestRoutes({
      publishThenConsume: opts.publishThenConsume,
      streamBuffer: {
        init: async () => undefined,
        publishRawChunk: async (_taskId: string, chunk: unknown) => {
          publishedRaw.push(chunk);
          return true;
        },
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
    savedMessages,
    updates,
    purged,
    pumped,
    publishedRaw,
    pumpPromises,
    sseEvents,
    bumps: () => bumps,
    setRunFence: (token: string | null) => {
      currentRunFence = token;
    },
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

  test("410 relay_session_lost for a resumed relay with no session", async () => {
    const { app, appended } = appWithContext();

    const res = await postChunks(app, relayBody([{ type: "done" }], 5), {
      "x-relay-from": "5",
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "relay_session_lost" });
    expect(appended).toEqual([]);
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

  test("happy path: full relay → 200 {ok,lastSeq}, parts committed, run completed, SSE emitted", async () => {
    const { app, appended, updates, purged, sseEvents, bumps } =
      appWithContext();

    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];
    const res = await postChunks(app, relayBody(events));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastSeq: events.length });

    // v2 persistence: a text part + a finish anchor landed via PartEmitter.
    const rows = appended.flat();
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("text");
    expect(kinds).toContain("finish");
    const textRow = rows.find((r) => r.kind === "text")!;
    expect((textRow.payload as { text?: string }).text).toBe("hello");

    // Terminal status transition (guarded completed update) + purge + SSE.
    expect(updates.map((u) => u.data)).toContainEqual({
      status: "completed",
      run_owner_pod: null,
      run_config: null,
      run_started_at: null,
    });
    expect(purged).toEqual([RUN_ID]);
    expect(sseEvents.map(({ event }) => event.type)).toEqual([
      "decopilot.thread.status",
      "decopilot.finish",
    ]);
    expect(bumps()).toBeGreaterThanOrEqual(1);
  });

  test("publishThenConsume: publishes RAW chunks in wire order AND keeps persistence parity", async () => {
    const { app, appended, updates, publishedRaw, pumped } = appWithContext({
      publishThenConsume: true,
    });

    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];
    const res = await postChunks(app, relayBody(events));
    expect(res.status).toBe(200);

    // Every relayed ui-message-chunk was published RAW, in wire order, with no
    // fold/interception (the daemon's raw harness output IS the NATS source).
    const types = publishedRaw.map((c) => (c as { type: string }).type);
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    // The processed uiStream is NOT pumped to NATS in this mode (raw is the
    // source); it is only drained for persistence.
    expect(pumped).toHaveLength(0);

    // Persistence parity: identical part rows + terminal completion as legacy.
    const rows = appended.flat();
    expect(rows.filter((r) => r.kind === "text")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "finish")).toHaveLength(1);
    expect(
      (rows.find((r) => r.kind === "text")!.payload as { text?: string }).text,
    ).toBe("hello");
    expect(updates.map((u) => u.data)).toContainEqual({
      status: "completed",
      run_owner_pod: null,
      run_config: null,
      run_started_at: null,
    });
  });

  test("pumps kernel output into the live edge when JetStream is up", async () => {
    const { app, pumped, pumpPromises } = appWithContext({ withTail: true });

    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];
    const res = await postChunks(app, relayBody(events));
    await Promise.all(pumpPromises);

    expect(res.status).toBe(200);
    expect(pumped).toHaveLength(1);
    const types = pumped[0]!.map((c) => (c as { type: string }).type);
    expect(types).toContain("text-delta");
    expect(types).toContain("finish");
  });

  test("reconnect replays the full prefix without duplicating parts", async () => {
    const { app, appended, updates, sseEvents } = appWithContext();

    const turn = helloTurnChunks();
    // First POST: a partial upload (drops mid-message, no terminal line).
    const first = await postChunks(
      app,
      relayBody(chunkEvents(turn.slice(0, 4))),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, lastSeq: 4 });

    // Reconnect: the daemon resends the WHOLE prefix from seq 1 + the rest.
    const events = [...chunkEvents(turn), { type: "done" } as const];
    const second = await postChunks(app, relayBody(events));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, lastSeq: events.length });

    const rows = appended.flat();
    expect(rows.filter((r) => r.kind === "text")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "finish")).toHaveLength(1);
    expect(updates.filter((u) => u.data.status === "completed")).toHaveLength(
      1,
    );
    expect(sseEvents.map(({ event }) => event.type)).toEqual([
      "decopilot.thread.status",
      "decopilot.finish",
    ]);
  });

  test("a full re-POST after completion is idempotent (no double terminal effects)", async () => {
    // The terminal ack can be lost on the wire; the daemon then retries the
    // whole upload. The session is gone (consume settled → registry entry
    // removed), so a fresh one re-consumes — deterministic part ids and the
    // guarded completed-transition make that redelivery a no-op.
    const { app, appended, updates, sseEvents } = appWithContext();
    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];

    const first = await postChunks(app, relayBody(events));
    expect(first.status).toBe(200);
    const second = await postChunks(app, relayBody(events));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, lastSeq: events.length });

    const rows = appended.flat();
    expect(rows.filter((r) => r.kind === "text")).toHaveLength(1);
    expect(updates.filter((u) => u.data.status === "completed")).toHaveLength(
      1,
    );
    expect(sseEvents).toHaveLength(2);
  });

  test("error event fails the run durably and never emits completed SSE", async () => {
    const { app, appended, updates, purged, sseEvents } = appWithContext();

    const turn = helloTurnChunks();
    const events: RelayEvent[] = [
      ...chunkEvents(turn.slice(0, 5)), // start..text-end, no finish
      { type: "error", code: "sandbox_dead", message: "sandbox went away" },
      { type: "done" },
    ];
    const res = await postChunks(app, relayBody(events));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastSeq: events.length });

    // The kernel persisted an error part (v2 path) and the run is failed.
    const kinds = appended.flat().map((r) => r.kind);
    expect(kinds).toContain("error");
    expect(updates.map((u) => u.data)).toContainEqual({
      status: "failed",
      run_owner_pod: null,
      run_config: null,
      run_started_at: null,
    });
    expect(updates.filter((u) => u.data.status === "completed")).toHaveLength(
      0,
    );
    // Failure SSE parity with the hosted run-reactor: a failed run emits a
    // failed thread-status + finish event (never a completed one).
    const failureEventTypes = sseEvents.map(({ event }) => event.type);
    expect(failureEventTypes).toEqual([
      "decopilot.thread.status",
      "decopilot.finish",
    ]);
    const statusEvent = sseEvents.find(
      ({ event }) => event.type === "decopilot.thread.status",
    )!;
    expect(
      (statusEvent.event as { data?: { status?: string } }).data?.status,
    ).toBe("failed");
    const finishEvent = sseEvents.find(
      ({ event }) => event.type === "decopilot.finish",
    )!;
    expect(
      (finishEvent.event as { data?: { status?: string } }).data?.status,
    ).toBe("failed");
    // The live edge is still purged — the run is over either way.
    expect(purged).toEqual([RUN_ID]);
  });

  test("v1 thread persists the whole final message via saveMessages", async () => {
    const { app, appended, savedMessages, updates } = appWithContext({
      thread: makeThread({ message_storage_version: 1 }),
    });

    const events = [
      ...chunkEvents(helloTurnChunks()),
      { type: "done" } as const,
    ];
    const res = await postChunks(app, relayBody(events));

    expect(res.status).toBe(200);
    expect(appended).toEqual([]); // no part rows on v1
    expect(savedMessages).toHaveLength(1);
    const saved = savedMessages[0]![0] as {
      thread_id: string;
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(saved.thread_id).toBe(RUN_ID);
    expect(saved.role).toBe("assistant");
    expect(
      saved.parts.some((p) => p.type === "text" && p.text === "hello"),
    ).toBe(true);
    expect(updates.map((u) => u.data)).toContainEqual({
      status: "completed",
      run_owner_pod: null,
      run_config: null,
      run_started_at: null,
    });
  });

  test("persists a relayed title for a default-titled thread and emits the SSE title event", async () => {
    const { app, updates, sseEvents } = appWithContext({
      thread: makeThread({ title: "New chat" }),
    });

    const events: RelayEvent[] = [
      ...chunkEvents([
        ...helloTurnChunks().slice(0, 6), // start..finish-step
        {
          type: "data-title-result",
          data: { title: "Greeting the daemon" },
          transient: true,
        },
        { type: "finish" },
      ]),
      { type: "done" },
    ];
    const res = await postChunks(app, relayBody(events));

    expect(res.status).toBe(200);
    expect(updates.map((u) => u.data)).toContainEqual({
      title: "Greeting the daemon",
    });
    // buildOnTitleUpdated emits a thread-status event carrying the title,
    // then the completed path emits status + finish.
    const titleEvent = sseEvents.find(
      ({ event }) =>
        event.type === "decopilot.thread.status" &&
        (event as { data?: { title?: string } }).data?.title ===
          "Greeting the daemon",
    );
    expect(titleEvent).toBeDefined();
  });

  test("does not overwrite a user-set title", async () => {
    const { app, updates } = appWithContext(); // title: "Test thread"

    const events: RelayEvent[] = [
      ...chunkEvents([
        ...helloTurnChunks().slice(0, 6),
        {
          type: "data-title-result",
          data: { title: "Auto title" },
          transient: true,
        },
        { type: "finish" },
      ]),
      { type: "done" },
    ];
    const res = await postChunks(app, relayBody(events));

    expect(res.status).toBe(200);
    expect(updates.some((u) => "title" in u.data)).toBe(false);
  });

  test("same-fence reconnect attaches to the existing session (dedupe still works)", async () => {
    // Two POSTs with the SAME fence — the second must attach to the live
    // session and NOT splice into a fresh kernel, so parts aren't duplicated.
    const { app, appended, updates } = appWithContext();
    const turn = helloTurnChunks();

    const first = await postChunks(
      app,
      relayBody(chunkEvents(turn.slice(0, 4))),
    );
    expect(first.status).toBe(200);

    const events = [...chunkEvents(turn), { type: "done" } as const];
    const second = await postChunks(app, relayBody(events));
    expect(second.status).toBe(200);

    const rows = appended.flat();
    expect(rows.filter((r) => r.kind === "text")).toHaveLength(1);
    expect(updates.filter((u) => u.data.status === "completed")).toHaveLength(
      1,
    );
  });

  test("a fresh fence supersedes a parked session: new lines consumed from seq 1, run completes once", async () => {
    // First run's daemon dies mid-stream (partial upload, no terminal line) —
    // its session parks keyed by runId. A NEW run mints a fresh fence and
    // relays from seq 1. The route must evict the stale session and consume the
    // fresh lines into a fresh kernel rather than dropping them as replays.
    const { app, appended, updates, purged, sseEvents, setRunFence } =
      appWithContext();
    const turn = helloTurnChunks();

    // Parked first run (fence_1), partial.
    const first = await postChunks(
      app,
      relayBody(chunkEvents(turn.slice(0, 4))),
      { "x-fence-token": "fence_1" },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, lastSeq: 4 });

    // New run: DB fence rotates, daemon presents the new fence + relays from 1.
    setRunFence("fence_2");
    const events = [...chunkEvents(turn), { type: "done" } as const];
    const second = await postChunks(app, relayBody(events), {
      "x-fence-token": "fence_2",
    });
    expect(second.status).toBe(200);
    // Fresh session counts from seq 1 — not deduped against the stale session.
    expect(await second.json()).toEqual({ ok: true, lastSeq: events.length });

    const rows = appended.flat();
    // Exactly one finished message persisted by the FRESH session (the stale
    // session's eviction wrote no terminal status / parts).
    expect(rows.filter((r) => r.kind === "text")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "finish")).toHaveLength(1);
    const textRow = rows.find((r) => r.kind === "text")!;
    expect((textRow.payload as { text?: string }).text).toBe("hello");

    // The run completes exactly once — the superseded (stale) consume never
    // wrote a terminal status, so there's no completed/failed race.
    expect(updates.filter((u) => u.data.status === "completed")).toHaveLength(
      1,
    );
    expect(updates.filter((u) => u.data.status === "failed")).toHaveLength(0);
    expect(purged).toContain(RUN_ID);
    expect(sseEvents.map(({ event }) => event.type)).toEqual([
      "decopilot.thread.status",
      "decopilot.finish",
    ]);
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
