import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
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
          update: async (_id: string, data: unknown) => {
            updates.push(data);
          },
          messageParts: () => ({
            appendParts: async (rows: ThreadMessagePart[]) => {
              appended.push(rows);
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
        pump: () => undefined,
        createTailStream: async () => null,
        purge: (taskId: string) => {
          purged.push(taskId);
        },
        teardown: () => undefined,
      },
    }),
  );
  return { app, appended, updates, purged };
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
    const { app, updates, purged } = appWithContext();

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
