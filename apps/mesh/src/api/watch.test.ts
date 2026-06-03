/**
 * Tests for the SSE watch handler — `GET /api/:org/watch`.
 *
 * The handler emits only a `connected` frame on connect followed by live
 * events. Clients use `COLLECTION_THREADS_LIST` for their initial state.
 * The handler logic itself lives in `app.ts`; we mount it directly on an
 * inline Hono app so the test doesn't have to bootstrap the full mesh
 * application.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { watchHandler } from "./app";
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
  } as unknown as StudioContext;

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
    virtual_mcp_id: overrides.virtual_mcp_id ?? "",
    branch: overrides.branch ?? null,
    sandbox_provider_kind: overrides.sandbox_provider_kind ?? null,
    harness_id: overrides.harness_id ?? null,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
    created_by: overrides.created_by ?? "user_1",
    updated_by: overrides.updated_by,
    hidden: overrides.hidden ?? false,
  };
}

describe("GET /api/:org/watch", () => {
  test("returns 200 with text/event-stream content type", async () => {
    const setup = makeWatchApp({ threads: [] });
    const res = await setup.app.request("/watch");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body!.cancel().catch(() => {});
  });

  test("emits the `connected` frame on connect and does NOT emit a snapshot", async () => {
    const setup = makeWatchApp({
      threads: [makeThread({ id: "t-1" })],
    });
    const res = await setup.app.request("/watch?types=decopilot.thread.*");
    const body = await readUntilFrames(res, { requireSnapshot: false });
    expect(body).toContain("event: connected");
    expect(body).not.toContain("event: snapshot");
    expect(setup.listCalls).toBe(0);
  });
});
