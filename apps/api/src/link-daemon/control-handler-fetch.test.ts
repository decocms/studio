import { describe, expect, test } from "bun:test";
import type { RequestFrame } from "../links/link-control-types";
import { sleep } from "@decocms/shared/std";
import type { ControlHandler } from "./control-handler";
import { createControlHandlerFetch } from "./control-handler-fetch";

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("createControlHandlerFetch", () => {
  test("routes POST /api/sandboxes to handle with body and headers", async () => {
    const handledFrames: RequestFrame[] = [];
    const handler: ControlHandler = {
      handle: async (frame) => {
        handledFrames.push(frame);
        return {
          status: 201,
          headers: {
            "content-type": "application/json",
            "x-sandbox": "created",
          },
          body: JSON.stringify({ ok: true }),
        };
      },
      handleStream: () => {
        throw new Error("handleStream must not be called");
      },
    };

    const fetchHandler = createControlHandlerFetch(handler);
    const response = await fetchHandler(
      new Request("http://tunnel.local/api/sandboxes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test": "kept",
        },
        body: JSON.stringify({ handle: "h" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-sandbox")).toBe("created");
    expect(await response.json()).toEqual({ ok: true });
    expect(handledFrames).toHaveLength(1);
    expect(handledFrames[0]).toMatchObject({
      type: "request",
      method: "POST",
      path: "/api/sandboxes",
      headers: {
        "content-type": "application/json",
        "x-test": "kept",
      },
      body: JSON.stringify({ handle: "h" }),
    });
    expect(handledFrames[0]?.reqId).toBeString();
  });

  test("routes lifecycle sandbox handle paths to handle and preserves query string", async () => {
    const handledFrames: RequestFrame[] = [];
    const handler: ControlHandler = {
      handle: async (frame) => {
        handledFrames.push(frame);
        return { status: 204 };
      },
      handleStream: () => {
        throw new Error("handleStream must not be called");
      },
    };

    const fetchHandler = createControlHandlerFetch(handler);
    const response = await fetchHandler(
      new Request("http://tunnel.local/api/sandboxes/h?probe=1", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(204);
    expect(handledFrames).toHaveLength(1);
    expect(handledFrames[0]).toMatchObject({
      type: "request",
      method: "DELETE",
      path: "/api/sandboxes/h?probe=1",
      headers: {},
    });
    expect(handledFrames[0]?.body).toBeUndefined();
  });

  test("routes POST /api/links/work to handle as a tunnel command", async () => {
    const handledFrames: RequestFrame[] = [];
    const body = JSON.stringify({ runId: "run-1" });
    const handler: ControlHandler = {
      handle: async (frame) => {
        handledFrames.push(frame);
        return { status: 202 };
      },
      handleStream: () => {
        throw new Error("handleStream must not be called");
      },
    };

    const fetchHandler = createControlHandlerFetch(handler);
    const response = await fetchHandler(
      new Request("http://tunnel.local/api/links/work", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

    expect(response.status).toBe(202);
    expect(handledFrames).toHaveLength(1);
    expect(handledFrames[0]).toMatchObject({
      type: "request",
      method: "POST",
      path: "/api/links/work",
      headers: { "content-type": "application/json" },
      body,
    });
  });

  test("routes proxy requests to handleStream with the request signal and streams raw bytes", async () => {
    const ac = new AbortController();
    let streamedFrame: RequestFrame | null = null;
    let streamedSignal: AbortSignal | undefined;
    const handler: ControlHandler = {
      handle: async () => {
        throw new Error("handle must not be called");
      },
      handleStream: async function* (frame, signal) {
        streamedFrame = frame;
        streamedSignal = signal;
        yield {
          type: "headers",
          status: 200,
          headers: { "content-type": "text/plain" },
        };
        yield { type: "raw-chunk", data: textBytes("hello") };
      },
    };

    const fetchHandler = createControlHandlerFetch(handler);
    const response = await fetchHandler(
      new Request("http://tunnel.local/_sandbox/h/events", {
        method: "GET",
        signal: ac.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("hello");
    expect(streamedSignal?.aborted).toBe(false);
    ac.abort();
    expect(streamedSignal?.aborted).toBe(true);
    expect(streamedFrame).toMatchObject({
      type: "request",
      method: "GET",
      path: "/_sandbox/h/events",
      headers: {},
    });
  });

  test("returns 502 when the first stream event is not headers", async () => {
    const handler: ControlHandler = {
      handle: async () => {
        throw new Error("handle must not be called");
      },
      handleStream: async function* () {
        yield { type: "raw-chunk", data: textBytes("early") };
      },
    };

    const response = await createControlHandlerFetch(handler)(
      new Request("http://tunnel.local/_sandbox/h/events"),
    );

    expect(response.status).toBe(502);
  });

  test("canceling a streamed response aborts the active stream signal and runs generator cleanup", async () => {
    let streamSignal: AbortSignal | undefined;
    let cleanupRan = false;
    let waitingForAbort = false;
    const handler: ControlHandler = {
      handle: async () => {
        throw new Error("handle must not be called");
      },
      handleStream: async function* (_frame, signal) {
        streamSignal = signal;
        yield {
          type: "headers",
          status: 200,
          headers: {},
        };
        try {
          await new Promise<void>((resolve) => {
            waitingForAbort = true;
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        } finally {
          cleanupRan = true;
        }
      },
    };

    const response = await createControlHandlerFetch(handler)(
      new Request("http://tunnel.local/_sandbox/h/events"),
    );
    const reader = response.body!.getReader();
    const read = reader.read();
    while (!waitingForAbort) await sleep(1);
    const cancel = reader.cancel();

    await expect(Promise.race([cancel, sleep(100)])).resolves.toBeUndefined();
    await read.catch(() => undefined);
    expect(streamSignal?.aborted).toBe(true);
    expect(cleanupRan).toBe(true);
  });
});
