/**
 * Tests for the SSE watch handler — `GET /api/:org/watch`.
 *
 * Covers the snapshot frame the handler emits on connect when the listener's
 * type filter overlaps with the thread event namespace. The handler logic
 * itself lives in `app.ts`; we mount it directly on an inline Hono app so the
 * test doesn't have to bootstrap the full mesh application.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "@/core/mesh-context";
import { THREAD_SNAPSHOT_PROBE_TYPE, watchHandler } from "./app";
import type { Env } from "./hono-env";
import type { Thread } from "@/storage/types";

interface WatchTestSetup {
  app: Hono<Env>;
  listCalls: number;
}

function makeWatchApp(opts?: {
  threads?: Thread[];
  listError?: Error;
}): WatchTestSetup {
  let listCalls = 0;
  const threads = opts?.threads ?? [];

  const ctx = {
    organization: { id: "org_1", slug: "acme" },
    auth: { user: { id: "user_1" } },
    storage: {
      threads: {
        list: async () => {
          listCalls += 1;
          if (opts?.listError) {
            throw opts.listError;
          }
          return { threads, total: threads.length };
        },
      },
    },
  } as unknown as MeshContext;

  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("meshContext", ctx);
    await next();
  });
  app.get("/watch", watchHandler);

  return {
    app,
    get listCalls() {
      return listCalls;
    },
  };
}

/**
 * Read SSE frames from a streaming response until both the `connected` and
 * (optionally) `snapshot` events have arrived, then cancel the body so the
 * handler's keepalive interval shuts down and the test process exits.
 *
 * The watch handler holds the response open indefinitely (keepalive + onAbort
 * wait); reading the whole body would hang the test.
 */
async function readUntilFrames(
  res: Response,
  options: { requireSnapshot: boolean; timeoutMs?: number },
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const timeoutMs = options.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let buf = "";

  try {
    while (Date.now() < deadline) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>(
        (resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            Math.max(0, deadline - Date.now()),
          ),
      );
      const { done, value } = await Promise.race([readPromise, timeoutPromise]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const hasConnected = buf.includes("event: connected");
      const hasSnapshot = buf.includes("event: snapshot");
      if (
        hasConnected &&
        (options.requireSnapshot ? hasSnapshot : true) &&
        // Drain at least one full frame boundary so callers see complete data
        buf.includes("\n\n")
      ) {
        if (!options.requireSnapshot) {
          // Wait one short tick to give the handler a chance to emit a snapshot
          // we don't want — if it shows up, the negative-case assertion catches it.
          await new Promise((r) => setTimeout(r, 50));
          const racePromise = reader.read();
          const tinyTimeout = new Promise<{ done: true; value: undefined }>(
            (resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 30),
          );
          const tail = await Promise.race([racePromise, tinyTimeout]);
          if (!tail.done && tail.value) {
            buf += decoder.decode(tail.value, { stream: true });
          }
        }
        break;
      }
    }
  } finally {
    buf += decoder.decode();
    await reader.cancel().catch(() => {});
  }

  return buf;
}

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: overrides.id ?? "thrd_1",
    organization_id: overrides.organization_id ?? "org_1",
    title: overrides.title ?? "Test thread",
    description: overrides.description ?? null,
    status: overrides.status ?? "completed",
    trigger_id: overrides.trigger_id ?? null,
    context_start_message_id: overrides.context_start_message_id ?? null,
    run_owner_pod: overrides.run_owner_pod ?? null,
    run_config: overrides.run_config ?? null,
    run_started_at: overrides.run_started_at ?? null,
    inflight_async_jobs: overrides.inflight_async_jobs ?? null,
    virtual_mcp_id: overrides.virtual_mcp_id ?? "",
    branch: overrides.branch ?? null,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
    created_by: overrides.created_by ?? "user_1",
    updated_by: overrides.updated_by,
    hidden: overrides.hidden ?? false,
  };
}

describe("GET /api/:org/watch — thread snapshot frame", () => {
  test("emits snapshot when types filter is decopilot.thread.*", async () => {
    const threads = [
      makeThread({ id: "thrd_a", title: "A" }),
      makeThread({ id: "thrd_b", title: "B" }),
    ];
    const setup = makeWatchApp({ threads });

    const res = await setup.app.request("/watch?types=decopilot.thread.*");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await readUntilFrames(res, { requireSnapshot: true });

    const connectedIdx = body.indexOf("event: connected");
    const snapshotIdx = body.indexOf("event: snapshot");
    expect(connectedIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotIdx).toBeGreaterThan(connectedIdx);

    expect(setup.listCalls).toBe(1);

    // The snapshot data line should parse to { threads: [...] }
    const afterSnapshot = body.slice(snapshotIdx);
    const dataMatch = afterSnapshot.match(/^data: (.*)$/m);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]!) as { threads: Thread[] };
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.threads[0]!.id).toBe("thrd_a");
    expect(parsed.threads[1]!.id).toBe("thrd_b");
  });

  test("does NOT emit snapshot when types filter excludes thread events", async () => {
    const setup = makeWatchApp({
      threads: [makeThread({ id: "thrd_a" })],
    });

    const res = await setup.app.request("/watch?types=workflow.*");
    expect(res.status).toBe(200);

    const body = await readUntilFrames(res, { requireSnapshot: false });
    expect(body).toContain("event: connected");
    expect(body).not.toContain("event: snapshot");
    expect(setup.listCalls).toBe(0);
  });

  test("emits snapshot when types param is omitted (subscribe to everything)", async () => {
    const setup = makeWatchApp({
      threads: [makeThread({ id: "thrd_a" })],
    });

    const res = await setup.app.request("/watch");
    expect(res.status).toBe(200);

    const body = await readUntilFrames(res, { requireSnapshot: true });
    expect(body).toContain("event: connected");
    expect(body).toContain("event: snapshot");
    expect(setup.listCalls).toBe(1);
  });

  test("emits snapshot for broader wildcard patterns that cover the thread namespace", async () => {
    // Patterns the SSE hub's `matchesAnyPattern` recognizes as covering the
    // thread namespace. The literal `*` is intentionally NOT included here:
    // the hub matcher only supports `prefix.*` (suffix wildcard) and exact
    // matches, so a bare `*` would NOT cause the hub to deliver live thread
    // events to the listener — emitting a snapshot in that case would create
    // an inconsistent listener.
    for (const pattern of ["decopilot.*", "decopilot.thread.*"]) {
      const setup = makeWatchApp({
        threads: [makeThread({ id: "thrd_a" })],
      });

      const res = await setup.app.request(
        `/watch?types=${encodeURIComponent(pattern)}`,
      );
      expect(res.status).toBe(200);

      const body = await readUntilFrames(res, { requireSnapshot: true });
      expect(body).toContain("event: snapshot");
      expect(setup.listCalls).toBe(1);
    }
  });

  test("snapshot probe type lives in the thread namespace", () => {
    // Sanity check that the probe type the handler matches against is
    // actually a member of the thread namespace it claims to represent.
    expect(THREAD_SNAPSHOT_PROBE_TYPE.startsWith("decopilot.thread.")).toBe(
      true,
    );
  });

  test("emits error frame and closes stream when snapshot list() throws", async () => {
    const setup = makeWatchApp({
      listError: new Error("simulated db outage"),
    });

    const res = await setup.app.request("/watch?types=decopilot.thread.*");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // The handler returns after emitting the error frame, so the stream
    // should close on its own — read the body to completion.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawDone = false;
    const deadline = Date.now() + 2000;

    try {
      while (Date.now() < deadline) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{
          done: true;
          value: undefined;
        }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            Math.max(0, deadline - Date.now()),
          ),
        );
        const { done, value } = await Promise.race([
          readPromise,
          timeoutPromise,
        ]);
        if (done) {
          sawDone = true;
          break;
        }
        buf += decoder.decode(value, { stream: true });
      }
    } finally {
      buf += decoder.decode();
      await reader.cancel().catch(() => {});
    }

    expect(setup.listCalls).toBe(1);
    expect(buf).toContain("event: connected");
    expect(buf).toContain("event: error");
    expect(buf).not.toContain("event: snapshot");
    // The handler returned after the error frame — the stream is closed.
    expect(sawDone).toBe(true);

    // The error payload should mirror the "Too many connections" shape:
    // a JSON object with `error` and `message` fields.
    const errorIdx = buf.indexOf("event: error");
    const afterError = buf.slice(errorIdx);
    const dataMatch = afterError.match(/^data: (.*)$/m);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]!) as {
      error: string;
      message: string;
    };
    expect(parsed.error).toBe("Snapshot unavailable");
    expect(parsed.message).toContain("Reconnect to retry");
  });

  test("snapshot rows are run through normalizeThreadForResponse", async () => {
    // Seed two rows that exercise the two normalizer behaviours:
    //  - `hidden: null` should be coerced to `false`
    //  - an `in_progress` thread whose `updated_at` is ≥ 31min in the past
    //    should be surfaced as the virtual `"expired"` status
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const threads = [
      makeThread({
        id: "thrd_stale",
        status: "in_progress",
        updated_at: stale,
        // Cast through unknown so the test can simulate the raw storage shape
        // (which may legitimately return `hidden: null` for older rows).
        hidden: null as unknown as boolean,
      }),
      makeThread({
        id: "thrd_fresh",
        status: "in_progress",
        updated_at: fresh,
      }),
    ];
    const setup = makeWatchApp({ threads });

    const res = await setup.app.request("/watch?types=decopilot.thread.*");
    expect(res.status).toBe(200);

    const body = await readUntilFrames(res, { requireSnapshot: true });
    const snapshotIdx = body.indexOf("event: snapshot");
    expect(snapshotIdx).toBeGreaterThan(-1);

    const afterSnapshot = body.slice(snapshotIdx);
    const dataMatch = afterSnapshot.match(/^data: (.*)$/m);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]!) as {
      threads: Array<
        Omit<Thread, "status" | "hidden"> & { status: string; hidden: boolean }
      >;
    };

    expect(parsed.threads).toHaveLength(2);

    const staleRow = parsed.threads.find((t) => t.id === "thrd_stale")!;
    expect(staleRow.status).toBe("expired");
    // null → false coercion
    expect(staleRow.hidden).toBe(false);

    const freshRow = parsed.threads.find((t) => t.id === "thrd_fresh")!;
    // A fresh in_progress thread should NOT be surfaced as expired.
    expect(freshRow.status).toBe("in_progress");
  });
});
