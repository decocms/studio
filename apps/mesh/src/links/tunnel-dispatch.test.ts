import { describe, expect, test } from "bun:test";
import type { NatsConnection } from "@nats-io/nats-core";
import { buildUserTunnelHostname } from "./tunnel-host";
import {
  createTunnelDispatch,
  responseToDispatchChunks,
  type TunnelFetch,
} from "./tunnel-dispatch";

const textEncoder = new TextEncoder();

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
};

const asNats = (connection: object): NatsConnection =>
  connection as NatsConnection;

describe("responseToDispatchChunks", () => {
  test("maps response headers/status and body chunks to dispatch chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode("hello"));
        controller.enqueue(new Uint8Array([0, 1, 2, 255]));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "x-test": "yes",
      },
    });

    await expect(collect(responseToDispatchChunks(response))).resolves.toEqual([
      {
        headers: {
          status: 206,
          headers: {
            "content-type": "application/octet-stream",
            "x-test": "yes",
          },
        },
      },
      { data: Buffer.from("hello").toString("base64") },
      { data: Buffer.from([0, 1, 2, 255]).toString("base64") },
    ]);
  });

  test("cancels upstream response body when returned after headers", async () => {
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
      },
    });

    const iterator = responseToDispatchChunks(
      new Response(body, { status: 200 }),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { headers: { status: 200, headers: {} } },
    });
    await iterator.return?.();

    expect(cancelCalled).toBe(true);
  });

  test("cancels upstream response body when returned after a data chunk", async () => {
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode("chunk"));
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const iterator = responseToDispatchChunks(
      new Response(body, { status: 200 }),
    )[Symbol.asyncIterator]();

    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { data: Buffer.from("chunk").toString("base64") },
    });
    await iterator.return?.();

    expect(cancelCalled).toBe(true);
  });
});

describe("createTunnelDispatch", () => {
  test("computes hostname from userSub, forwards request init, and yields chunks", async () => {
    const nats = asNats({});
    const abortController = new AbortController();
    const calls: Array<{
      connection: NatsConnection;
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    const tunnelFetch: TunnelFetch = async (input, init) => {
      calls.push({ connection: nats, input, init });
      return new Response("ok", {
        status: 201,
        headers: { "x-reply": "received" },
      });
    };
    const dispatch = createTunnelDispatch({
      getConnection: () => nats,
      createFetch: (connection) => {
        expect(connection).toBe(nats);
        return tunnelFetch;
      },
    });

    const chunks = await collect(
      dispatch(
        "user-1",
        {
          method: "POST",
          path: "/v1/proxy?debug=1",
          headers: { authorization: "Bearer test", "x-test": "yes" },
          body: "request-body",
        },
        { signal: abortController.signal },
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(
      `tunnel://${buildUserTunnelHostname("user-1")}/v1/proxy?debug=1`,
    );
    expect(calls[0]!.init).toEqual({
      method: "POST",
      headers: { authorization: "Bearer test", "x-test": "yes" },
      body: "request-body",
      signal: abortController.signal,
    });
    expect(calls[0]!.init?.signal).toBe(abortController.signal);
    expect(chunks).toEqual([
      {
        headers: {
          status: 201,
          headers: {
            "x-reply": "received",
          },
        },
      },
      { data: Buffer.from("ok").toString("base64") },
    ]);
  });

  test("NATS unavailable throws", async () => {
    const dispatch = createTunnelDispatch({
      getConnection: () => null,
      createFetch: () => async () => new Response(),
    });

    await expect(
      collect(dispatch("user-1", { method: "GET", path: "/", headers: {} })),
    ).rejects.toThrow("link_unavailable: NATS unavailable");
  });

  test("a fetch rejection propagates", async () => {
    const dispatch = createTunnelDispatch({
      getConnection: () => asNats({}),
      createFetch: () => async () => {
        throw new Error("tunnel_no_first_frame");
      },
    });

    await expect(
      collect(dispatch("user-1", { method: "GET", path: "/", headers: {} })),
    ).rejects.toThrow("tunnel_no_first_frame");
  });
});
