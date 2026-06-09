import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { UIMessageChunk } from "ai";
import type { SSEEvent } from "@/event-bus";
import type { ThreadMessagePart } from "@/storage/fold-parts";
import type { Env } from "../../hono-env";
import { createLinkIngestRoutes } from "./link-ingest-routes";

function makeRow(
  overrides: Partial<ThreadMessagePart> = {},
): ThreadMessagePart {
  return {
    id: "run_1:0",
    seq: 0,
    org_id: "org_1",
    thread_id: "run_1",
    run_id: "run_1",
    message_id: "assistant_1",
    role: "assistant",
    kind: "text",
    payload: { type: "text", text: "hello" },
    payload_ref: null,
    metadata: null,
    created_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function appWithContext(ctx: Record<string, unknown> = {}) {
  const appended: ThreadMessagePart[][] = [];
  const updates: unknown[] = [];
  const purged: string[] = [];
  const pumped: UIMessageChunk[][] = [];
  const pumpPromises: Promise<void>[] = [];
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const insertedIds = new Set<string>();
  let threadStatus = "in_progress";
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("meshContext", {
      auth: { user: { id: "user_1" } },
      organization: { id: "org_1", slug: "acme" },
      storage: {
        threads: {
          getCancelRequestedAt: async () => null,
          getRunFence: async () => "fence_1",
          bumpProgress: async () => undefined,
          get: async () => ({
            id: "run_1",
            status: threadStatus,
            virtual_mcp_id: "vmcp_1",
            created_by: "user_1",
            trigger_id: null,
            title: "Test thread",
            branch: null,
            created_at: "2026-06-09T00:00:00.000Z",
            updated_at: "2026-06-09T00:00:01.000Z",
          }),
          update: async (_id: string, data: unknown) => {
            updates.push(data);
            if (
              typeof data === "object" &&
              data !== null &&
              "status" in data &&
              typeof data.status === "string"
            ) {
              threadStatus = data.status;
            }
          },
          messageParts: () => ({
            appendParts: async (rows: ThreadMessagePart[]) => {
              const inserted = rows.filter((row) => !insertedIds.has(row.id));
              for (const row of inserted) insertedIds.add(row.id);
              appended.push(inserted);
              return inserted;
            },
          }),
        },
      },
      ...ctx,
    } as unknown as Env["Variables"]["meshContext"]);
    await next();
  });
  app.route(
    "/api/:org",
    createLinkIngestRoutes({
      streamBuffer: {
        init: async () => undefined,
        pump: (stream: ReadableStream) => {
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
            pumped.push(chunks);
          })();
          pumpPromises.push(promise);
        },
        createTailStream: async () => null,
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
  return { app, appended, updates, purged, pumped, pumpPromises, sseEvents };
}

async function postParts(
  app: Hono<Env>,
  body: unknown,
  headers: Record<string, string> = { "x-fence-token": "fence_1" },
) {
  return await app.request("/api/acme/links/runs/run_1/parts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("link ingest parts route", () => {
  test("appends rows and returns ok", async () => {
    const { app, appended } = appWithContext();
    const row = makeRow();

    const res = await postParts(app, {
      batchId: "batch_1",
      rows: [row],
      done: false,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      appended: 1,
      done: false,
    });
    expect(appended).toEqual([[row]]);
  });

  test("rejects rows whose run_id does not match path", async () => {
    const { app, appended } = appWithContext();

    const res = await postParts(app, {
      batchId: "batch_1",
      rows: [makeRow({ run_id: "other_run" })],
      done: false,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "row run mismatch" });
    expect(appended).toEqual([]);
  });

  test("rejects schema failures as a bad batch", async () => {
    const { app, appended } = appWithContext();

    const res = await postParts(app, {
      rows: [makeRow()],
      done: false,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad batch" });
    expect(appended).toEqual([]);
  });

  test("marks the run completed on done true", async () => {
    const { app, updates, purged, sseEvents } = appWithContext();

    const res = await postParts(app, {
      batchId: "batch_1",
      rows: [makeRow()],
      done: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      appended: 1,
      done: true,
    });
    expect(updates).toEqual([
      {
        status: "completed",
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
      },
    ]);
    expect(purged).toEqual(["run_1"]);
    expect(sseEvents.map(({ event }) => event.type)).toEqual([
      "decopilot.thread.status",
      "decopilot.finish",
    ]);
  });

  test("publishes appended rows and finish to the live stream buffer", async () => {
    const { app, pumped, pumpPromises } = appWithContext();

    const res = await postParts(app, {
      batchId: "batch_1",
      rows: [makeRow()],
      done: true,
    });
    await Promise.all(pumpPromises);

    expect(res.status).toBe(200);
    expect(pumped).toEqual([
      [
        { type: "start", messageId: "assistant_1" },
        { type: "start-step" },
        { type: "text-start", id: "run_1:0" },
        { type: "text-delta", id: "run_1:0", delta: "hello" },
        { type: "text-end", id: "run_1:0" },
        { type: "finish-step" },
        { type: "finish" },
      ],
    ]);
  });

  test("does not republish live chunks for a retried batch", async () => {
    const { app, pumped, pumpPromises, updates, sseEvents } = appWithContext();
    const body = {
      batchId: "batch_1",
      rows: [makeRow()],
      done: true,
    };

    const first = await postParts(app, body);
    const second = await postParts(app, body);
    await Promise.all(pumpPromises);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(pumped).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(sseEvents.map(({ event }) => event.type)).toEqual([
      "decopilot.thread.status",
      "decopilot.finish",
    ]);
  });

  test("rejects cancelled runs before fence check", async () => {
    let fenceChecks = 0;
    const { app } = appWithContext({
      storage: {
        threads: {
          getCancelRequestedAt: async () => "2026-06-09T00:00:00.000Z",
          getRunFence: async () => {
            fenceChecks++;
            return "fence_1";
          },
          bumpProgress: async () => undefined,
          update: async () => undefined,
          messageParts: () => ({
            appendParts: async () => undefined,
          }),
        },
      },
    });

    const res = await postParts(app, {
      batchId: "batch_1",
      rows: [makeRow()],
      done: false,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cancelled" });
    expect(fenceChecks).toBe(0);
  });

  test("rejects bad fence", async () => {
    const { app, appended } = appWithContext();

    const res = await postParts(
      app,
      {
        batchId: "batch_1",
        rows: [makeRow()],
        done: false,
      },
      { "x-fence-token": "wrong_fence" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "fenced" });
    expect(appended).toEqual([]);
  });
});
