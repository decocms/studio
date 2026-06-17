import { expect, test } from "bun:test";
import type { Msg, NatsConnection, Subscription } from "nats";

import {
  base64UrlEncode,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type RequestStartFrame,
  type TunnelFrame,
} from ".";
import { createFetch, serve } from "./nats";
import { buildTunnelSubjects } from "./subject";

const textDecoder = new TextDecoder();

class FakeSubscription implements Subscription {
  readonly closed: Promise<void>;
  #resolveClosed!: () => void;
  #messages: Msg[] = [];
  #waiters: Array<(result: IteratorResult<Msg>) => void> = [];
  #closed = false;
  #received = 0;
  #processed = 0;

  constructor(private readonly subject: string) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  push(msg: Msg): void {
    if (this.#closed) {
      return;
    }
    this.#received++;
    const waiter = this.#waiters.shift();
    if (waiter) {
      this.#processed++;
      waiter({ value: msg, done: false });
      return;
    }
    this.#messages.push(msg);
  }

  unsubscribe(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
    this.#resolveClosed();
  }

  drain(): Promise<void> {
    this.unsubscribe();
    return this.closed;
  }

  isDraining(): boolean {
    return false;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  callback(): void {}

  getSubject(): string {
    return this.subject;
  }

  getReceived(): number {
    return this.#received;
  }

  getProcessed(): number {
    return this.#processed;
  }

  getPending(): number {
    return this.#messages.length;
  }

  getID(): number {
    return 1;
  }

  getMax(): number | undefined {
    return undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<Msg> {
    return {
      next: () => {
        if (this.#messages.length > 0) {
          this.#processed++;
          return Promise.resolve({
            value: this.#messages.shift() as Msg,
            done: false,
          });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: () => {
        this.unsubscribe();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class FakeNatsConnection {
  readonly published: Array<{ subject: string; frame: TunnelFrame }> = [];
  readonly subscriptions: Array<{ subject: string; queue?: string }> = [];
  #subscriptions = new Map<string, Set<FakeSubscription>>();

  publish(subject: string, payload?: Uint8Array | string): void {
    const data =
      typeof payload === "string"
        ? new TextEncoder().encode(payload)
        : (payload ?? new Uint8Array());
    this.published.push({ subject, frame: decodeTunnelFrame(data) });
    for (const [pattern, subs] of this.#subscriptions) {
      if (subjectMatches(pattern, subject)) {
        for (const sub of subs) {
          sub.push(createMsg(subject, data));
        }
      }
    }
  }

  subscribe(subject: string, opts?: { queue?: string }): Subscription {
    const sub = new FakeSubscription(subject);
    this.subscriptions.push({ subject, queue: opts?.queue });
    const subs = this.#subscriptions.get(subject) ?? new Set();
    subs.add(sub);
    this.#subscriptions.set(subject, subs);
    sub.closed.then(() => {
      subs.delete(sub);
    });
    return sub;
  }

  subscriptionFor(subject: string): FakeSubscription | undefined {
    return Array.from(this.#subscriptions.get(subject) ?? [])[0];
  }
}

const subjectMatches = (pattern: string, subject: string): boolean => {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index++) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return true;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
};

const createMsg = (subject: string, data: Uint8Array): Msg => ({
  subject,
  sid: 1,
  data,
  respond: () => false,
  json: () => JSON.parse(textDecoder.decode(data)),
  string: () => textDecoder.decode(data),
});

const asNats = (connection: FakeNatsConnection): NatsConnection => {
  return connection as unknown as NatsConnection;
};

const readText = async (response: Response): Promise<string> => {
  return await response.text();
};

const waitForPublished = async (
  connection: FakeNatsConnection,
  type: TunnelFrame["type"],
): Promise<TunnelFrame> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = connection.published.find(
      (entry) => entry.frame.type === type,
    )?.frame;
    if (frame) {
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`missing published ${type}`);
};

const waitForPublishedCount = async (
  connection: FakeNatsConnection,
  type: TunnelFrame["type"],
  count: number,
): Promise<TunnelFrame[]> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frames = connection.published
      .filter((entry) => entry.frame.type === type)
      .map((entry) => entry.frame);
    if (frames.length >= count) {
      return frames;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`missing ${count} published ${type} frames`);
};

const requestStartFrom = (frame: TunnelFrame): RequestStartFrame => {
  if (frame.type !== "request.start") {
    throw new Error(`expected request.start, got ${frame.type}`);
  }
  return frame;
};

const expectSettlesPromptly = async <T>(promise: Promise<T>): Promise<T> => {
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    promise,
    new Promise<typeof timeout>((resolve) => {
      setTimeout(() => resolve(timeout), 50);
    }),
  ]);

  if (result === timeout) {
    throw new Error("promise did not settle promptly");
  }

  return result;
};

test("createFetch and serve round-trip a streamed request and response", async () => {
  const fake = new FakeNatsConnection();
  const server = await serve({
    connection: asNats(fake),
    hostname: "example.test",
    maxChunkBytes: 3,
    fetch: async (request) => {
      expect(request.url).toBe("http://tunnel.local/echo?q=1");
      expect(request.headers.get("x-test")).toBe("yes");
      const body = await request.text();
      return new Response(`reply:${body}`, {
        status: 201,
        headers: [["x-reply", "ok"]],
      });
    },
  });

  const tunnelFetch = createFetch({
    connection: asNats(fake),
    maxChunkBytes: 2,
    firstFrameTimeoutMs: 100,
    republishIntervalMs: 1000,
  });
  const response = await tunnelFetch("tunnel://example.test/echo?q=1", {
    method: "POST",
    headers: [["x-test", "yes"]],
    body: "abcdefg",
  });

  expect(response.status).toBe(201);
  expect(response.headers.get("x-reply")).toBe("ok");
  expect(await readText(response)).toBe("reply:abcdefg");

  const requestChunks = fake.published.filter(
    (entry) => entry.frame.type === "request.chunk",
  );
  const responseChunks = fake.published.filter(
    (entry) => entry.frame.type === "response.chunk",
  );

  expect(requestChunks).toHaveLength(4);
  expect(responseChunks.length).toBeGreaterThan(1);
  expect(
    requestChunks
      .map((entry) =>
        entry.frame.type === "request.chunk" ? entry.frame.data : "",
      )
      .join(""),
  ).not.toBe("");

  await server.close();
  await server.closed;
});

test("createFetch waits for response ack before publishing request body chunks", async () => {
  const fake = new FakeNatsConnection();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("one"));
      controller.close();
    },
  });
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://delayed-ack.test/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  const start = requestStartFrom(await waitForPublished(fake, "request.start"));

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    fake.published.some((entry) => entry.frame.type === "request.chunk"),
  ).toBe(false);

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({ type: "response.ack", requestId: start.requestId }),
  );

  await waitForPublishedCount(fake, "request.chunk", 1);
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.start",
      requestId: start.requestId,
      status: 204,
      headers: [],
    }),
  );
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.end",
      requestId: start.requestId,
      seq: 0,
    }),
  );

  const response = await promise;
  expect(response.status).toBe(204);
  await response.text();
});

test("createFetch reads response chunks from NATS only when the response body is read", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://response-backpressure.test/");
  const start = requestStartFrom(await waitForPublished(fake, "request.start"));

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.start",
      requestId: start.requestId,
      status: 200,
      headers: [],
    }),
  );
  const response = await promise;
  const replySub = fake.subscriptionFor(start.replySubject);
  if (!replySub) {
    throw new Error("missing reply subscription");
  }
  expect(replySub.getProcessed()).toBe(1);

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.chunk",
      requestId: start.requestId,
      seq: 0,
      data: base64UrlEncode(new TextEncoder().encode("a")),
    }),
  );
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.chunk",
      requestId: start.requestId,
      seq: 1,
      data: base64UrlEncode(new TextEncoder().encode("b")),
    }),
  );
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.end",
      requestId: start.requestId,
      seq: 2,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(replySub.getProcessed()).toBe(1);

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing response body");
  }
  expect(textDecoder.decode((await reader.read()).value)).toBe("a");
  expect(replySub.getProcessed()).toBe(2);
  expect(textDecoder.decode((await reader.read()).value)).toBe("b");
  expect(replySub.getProcessed()).toBe(3);
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(replySub.getProcessed()).toBe(4);
});

test("createFetch publishes abort when a response body reader is canceled", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://response-cancel.test/");
  const start = requestStartFrom(await waitForPublished(fake, "request.start"));

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.start",
      requestId: start.requestId,
      status: 200,
      headers: [],
    }),
  );
  const response = await promise;
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing response body");
  }

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.chunk",
      requestId: start.requestId,
      seq: 0,
      data: base64UrlEncode(new TextEncoder().encode("a")),
    }),
  );

  expect(textDecoder.decode((await reader.read()).value)).toBe("a");
  await reader.cancel();

  const abort = await waitForPublished(fake, "abort");
  expect(abort).toEqual({
    type: "abort",
    requestId: start.requestId,
    reason: "response_body_cancelled",
  });
  expect(
    fake.published.some(
      (entry) => entry.subject === start.abortSubject && entry.frame === abort,
    ),
  ).toBe(true);
});

test("response stream errors when no frame arrives within idleTimeoutMs", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
    idleTimeoutMs: 50,
  });
  const promise = tunnelFetch("tunnel://idle-timeout.test/");
  const start = requestStartFrom(await waitForPublished(fake, "request.start"));

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.start",
      requestId: start.requestId,
      status: 200,
      headers: [],
    }),
  );
  const response = await promise;

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.chunk",
      requestId: start.requestId,
      seq: 0,
      data: base64UrlEncode(new TextEncoder().encode("a")),
    }),
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing response body");
  }
  expect(textDecoder.decode((await reader.read()).value)).toBe("a");

  // The server goes silent (never sends response.end). The next read must
  // reject once the inter-frame idle timeout fires.
  await expect(reader.read()).rejects.toThrow("tunnel_idle_timeout");
});

test("createFetch cleans up reply subscription for 204 responses without reading body", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://no-body-response.test/");
  const start = requestStartFrom(await waitForPublished(fake, "request.start"));
  const replySub = fake.subscriptionFor(start.replySubject);
  if (!replySub) {
    throw new Error("missing reply subscription");
  }

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.start",
      requestId: start.requestId,
      status: 204,
      headers: [],
    }),
  );

  const response = await promise;

  expect(response.status).toBe(204);
  expect(response.body).toBeNull();
  await expectSettlesPromptly(replySub.closed);
});

test("createFetch cleans per-iteration wait resources after skipped response frames", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 15,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://skip-response.test/");
  const start = requestStartFrom(await waitForPublished(fake, "request.start"));

  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.ack",
      requestId: "unrelated_request",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.start",
      requestId: start.requestId,
      status: 202,
      headers: [],
    }),
  );
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({
      type: "response.end",
      requestId: start.requestId,
      seq: 0,
    }),
  );

  const response = await promise;
  expect(response.status).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await response.text();
});

test("createFetch preserves tuple header order and duplicates from RequestInit", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 5,
    republishIntervalMs: 1000,
  });

  await expect(
    tunnelFetch("tunnel://headers.test/", {
      headers: [
        ["b", "2"],
        ["a", "1"],
        ["b", "3"],
      ],
    }),
  ).rejects.toThrow("tunnel_no_first_frame");

  const frame = await waitForPublished(fake, "request.start");

  expect(frame).toMatchObject({
    type: "request.start",
    headers: [
      ["b", "2"],
      ["a", "1"],
      ["b", "3"],
    ],
  });
});

test("createFetch preserves tuple init headers for Request input", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 5,
    republishIntervalMs: 1000,
  });
  const request = new Request("tunnel://request-headers.test/", {
    headers: [["x-original", "ignored"]],
  });

  await expect(
    tunnelFetch(request, {
      headers: [
        ["b", "2"],
        ["a", "1"],
        ["b", "3"],
      ],
    }),
  ).rejects.toThrow("tunnel_no_first_frame");

  const frame = await waitForPublished(fake, "request.start");

  expect(frame).toMatchObject({
    type: "request.start",
    headers: [
      ["b", "2"],
      ["a", "1"],
      ["b", "3"],
    ],
  });
});

test("createFetch rejects non-tunnel URLs", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch(asNats(fake));

  await expect(tunnelFetch("https://example.test/")).rejects.toThrow(
    "expected tunnel: URL",
  );
});

test("createFetch fails when the first response frame does not arrive", async () => {
  const fake = new FakeNatsConnection();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 5,
    republishIntervalMs: 1000,
  });

  await expect(tunnelFetch("tunnel://missing.test/")).rejects.toThrow(
    "tunnel_no_first_frame",
  );
});

test("createFetch publishes abort frames when the caller aborts", async () => {
  const fake = new FakeNatsConnection();
  const controller = new AbortController();
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://abort.test/", {
    signal: controller.signal,
  });

  await waitForPublished(fake, "request.start");
  controller.abort("stop");

  await expect(promise).rejects.toThrow("tunnel_aborted");
  const abort = await waitForPublished(fake, "abort");
  expect(abort).toMatchObject({ type: "abort", reason: "stop" });
});

test("createFetch stops pumping request body chunks after caller aborts", async () => {
  const fake = new FakeNatsConnection();
  const controller = new AbortController();
  let canceled = false;
  let secondChunkTimer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode("one"));
      secondChunkTimer = setTimeout(() => {
        streamController.enqueue(new TextEncoder().encode("two"));
      }, 50);
    },
    cancel() {
      canceled = true;
      if (secondChunkTimer) {
        clearTimeout(secondChunkTimer);
      }
    },
  });
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://abort-body.test/", {
    method: "POST",
    body,
    signal: controller.signal,
    duplex: "half",
  } as RequestInit);

  const start = requestStartFrom(await waitForPublished(fake, "request.start"));
  fake.publish(
    start.replySubject,
    encodeTunnelFrame({ type: "response.ack", requestId: start.requestId }),
  );
  await waitForPublishedCount(fake, "request.chunk", 1);

  controller.abort("stop");
  await expect(promise).rejects.toThrow("tunnel_aborted");

  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(canceled).toBe(true);
  expect(
    fake.published.filter((entry) => entry.frame.type === "request.chunk"),
  ).toHaveLength(1);
  expect(
    fake.published.some((entry) => entry.frame.type === "request.end"),
  ).toBe(false);
});

test("createFetch enforces timeoutMs and stops pumping request body", async () => {
  const fake = new FakeNatsConnection();
  let canceled = false;
  let secondChunkTimer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode("one"));
      secondChunkTimer = setTimeout(() => {
        streamController.enqueue(new TextEncoder().encode("two"));
      }, 10);
    },
    cancel() {
      canceled = true;
      if (secondChunkTimer) {
        clearTimeout(secondChunkTimer);
      }
    },
  });
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    timeoutMs: 5,
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://timeout-body.test/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);

  await waitForPublished(fake, "request.start");

  await expect(promise).rejects.toThrow("tunnel_timeout");
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(
    fake.published.filter((entry) => entry.frame.type === "request.chunk"),
  ).toHaveLength(0);
  expect(
    fake.published.some((entry) => entry.frame.type === "request.end"),
  ).toBe(false);
  expect(canceled).toBe(true);
});

test("createFetch timeout publishes abort after server ownership", async () => {
  const fake = new FakeNatsConnection();
  let handlerAborted = false;
  const server = await serve({
    connection: asNats(fake),
    hostname: "timeout-abort.test",
    fetch: async (request) => {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return new Response("late");
    },
  });
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    timeoutMs: 5,
    firstFrameTimeoutMs: 1000,
    republishIntervalMs: 1000,
  });

  await expect(tunnelFetch("tunnel://timeout-abort.test/")).rejects.toThrow(
    "tunnel_timeout",
  );
  await waitForPublished(fake, "abort");
  await expectSettlesPromptly(server.close());

  expect(handlerAborted).toBe(true);
});

test("createFetch cancels request body on firstFrameTimeout before ownership", async () => {
  const fake = new FakeNatsConnection();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode("one"));
    },
    cancel() {
      canceled = true;
    },
  });
  const tunnelFetch = createFetch({
    connection: asNats(fake),
    firstFrameTimeoutMs: 5,
    republishIntervalMs: 1000,
  });
  const promise = tunnelFetch("tunnel://first-frame-timeout-body.test/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);

  await waitForPublished(fake, "request.start");
  await expect(promise).rejects.toThrow("tunnel_no_first_frame");
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(canceled).toBe(true);
  expect(
    fake.published.filter((entry) => entry.frame.type === "request.chunk"),
  ).toHaveLength(0);
  expect(
    fake.published.some((entry) => entry.frame.type === "request.end"),
  ).toBe(false);
});

test("serve maps abort frames to the handler request signal", async () => {
  const fake = new FakeNatsConnection();
  let handlerSignal: AbortSignal | undefined;
  const server = await serve({
    connection: asNats(fake),
    hostname: "abort-server.test",
    fetch: async (request) => {
      handlerSignal = request.signal;
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return new Response("late");
    },
  });
  const subjects = buildTunnelSubjects("abort-server.test", "req_abort");

  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_abort",
      method: "GET",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
    }),
  );
  await waitForPublished(fake, "response.ack");
  fake.publish(
    subjects.abort,
    encodeTunnelFrame({
      type: "abort",
      requestId: "req_abort",
      reason: "client canceled",
    }),
  );

  for (let attempt = 0; attempt < 100 && !handlerSignal?.aborted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  expect(handlerSignal?.aborted).toBe(true);
  await server.close();
});

test("serve close aborts in-flight handler request signals", async () => {
  const fake = new FakeNatsConnection();
  let handlerAborted = false;
  const server = await serve({
    connection: asNats(fake),
    hostname: "server-close-abort.test",
    fetch: async (request) => {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return new Response("closed");
    },
  });
  const subjects = buildTunnelSubjects("server-close-abort.test", "req_close");

  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_close",
      method: "GET",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
    }),
  );

  await waitForPublished(fake, "response.ack");
  await expectSettlesPromptly(server.close());
  expect(handlerAborted).toBe(true);
});

test("serve reads request body frames from NATS only when the handler reads the body", async () => {
  const fake = new FakeNatsConnection();
  let capturedRequest: Request | undefined;
  let releaseHandler!: () => void;
  const handlerReleased = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const server = await serve({
    connection: asNats(fake),
    hostname: "request-backpressure.test",
    fetch: async (request) => {
      capturedRequest = request;
      await handlerReleased;
      return new Response("ok");
    },
  });
  const subjects = buildTunnelSubjects("request-backpressure.test", "req_body");

  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_body",
      method: "POST",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
      bodySubject: subjects.body,
    }),
  );

  await waitForPublished(fake, "response.ack");
  const bodySub = fake.subscriptionFor(subjects.body);
  if (!bodySub) {
    throw new Error("missing body subscription");
  }

  fake.publish(
    subjects.body,
    encodeTunnelFrame({
      type: "request.chunk",
      requestId: "req_body",
      seq: 0,
      data: base64UrlEncode(new TextEncoder().encode("a")),
    }),
  );
  fake.publish(
    subjects.body,
    encodeTunnelFrame({
      type: "request.chunk",
      requestId: "req_body",
      seq: 1,
      data: base64UrlEncode(new TextEncoder().encode("b")),
    }),
  );
  fake.publish(
    subjects.body,
    encodeTunnelFrame({
      type: "request.end",
      requestId: "req_body",
      seq: 2,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(bodySub.getProcessed()).toBe(0);

  const reader = capturedRequest?.body?.getReader();
  if (!reader) {
    throw new Error("missing request body");
  }
  expect(textDecoder.decode((await reader.read()).value)).toBe("a");
  expect(bodySub.getProcessed()).toBe(1);
  expect(textDecoder.decode((await reader.read()).value)).toBe("b");
  expect(bodySub.getProcessed()).toBe(2);
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(bodySub.getProcessed()).toBe(3);

  releaseHandler();
  await waitForPublished(fake, "response.start");
  await server.close();
});

test("serve abort cancels stalled response body pumping and close resolves", async () => {
  const fake = new FakeNatsConnection();
  let responseCanceled = false;
  const server = await serve({
    connection: asNats(fake),
    hostname: "abort-response.test",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull() {
            await new Promise(() => {});
          },
          cancel() {
            responseCanceled = true;
          },
        }),
      ),
  });
  const subjects = buildTunnelSubjects("abort-response.test", "req_response");

  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_response",
      method: "GET",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
    }),
  );

  await waitForPublished(fake, "response.start");
  fake.publish(
    subjects.abort,
    encodeTunnelFrame({
      type: "abort",
      requestId: "req_response",
      reason: "client canceled",
    }),
  );

  await expectSettlesPromptly(server.close());
  expect(responseCanceled).toBe(true);
  expect(
    fake.published.some((entry) => entry.frame.type === "response.end"),
  ).toBe(false);
});

test("serve abort unblocks handler consuming incomplete request body", async () => {
  const fake = new FakeNatsConnection();
  let handlerUnblocked = false;
  const server = await serve({
    connection: asNats(fake),
    hostname: "abort-request-body.test",
    fetch: async (request) => {
      try {
        await request.text();
      } catch {
        handlerUnblocked = true;
      }
      return new Response("aborted");
    },
  });
  const subjects = buildTunnelSubjects(
    "abort-request-body.test",
    "req_body_abort",
  );

  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_body_abort",
      method: "POST",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
      bodySubject: subjects.body,
    }),
  );
  await waitForPublished(fake, "response.ack");
  fake.publish(
    subjects.body,
    encodeTunnelFrame({
      type: "request.chunk",
      requestId: "req_body_abort",
      seq: 0,
      data: base64UrlEncode(new TextEncoder().encode("partial")),
    }),
  );
  fake.publish(
    subjects.abort,
    encodeTunnelFrame({
      type: "abort",
      requestId: "req_body_abort",
      reason: "client canceled",
    }),
  );

  await expectSettlesPromptly(server.close());
  expect(handlerUnblocked).toBe(true);
});

test("serve skips and cancels response bodies for HEAD requests", async () => {
  const fake = new FakeNatsConnection();
  let responseCanceled = false;
  const server = await serve({
    connection: asNats(fake),
    hostname: "head-response.test",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull() {
            await new Promise(() => {});
          },
          cancel() {
            responseCanceled = true;
          },
        }),
      ),
  });
  const subjects = buildTunnelSubjects("head-response.test", "req_head");

  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_head",
      method: "HEAD",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
    }),
  );

  await waitForPublished(fake, "response.start");
  await waitForPublished(fake, "response.end");
  await expectSettlesPromptly(server.close());

  expect(responseCanceled).toBe(true);
  expect(
    fake.published.some((entry) => entry.frame.type === "response.chunk"),
  ).toBe(false);
});

test("serve applies abort frames that arrive before request handling", async () => {
  const fake = new FakeNatsConnection();
  let requestAborted = false;
  const server = await serve({
    connection: asNats(fake),
    hostname: "pending-abort.test",
    fetch: async (request) => {
      requestAborted = request.signal.aborted;
      return new Response("aborted");
    },
  });
  const subjects = buildTunnelSubjects("pending-abort.test", "req_pending");

  fake.publish(
    subjects.abort,
    encodeTunnelFrame({
      type: "abort",
      requestId: "req_pending",
      reason: "client canceled early",
    }),
  );
  fake.publish(
    subjects.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_pending",
      method: "GET",
      url: "/",
      headers: [],
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
    }),
  );

  await waitForPublished(fake, "response.start");
  await expectSettlesPromptly(server.close());
  expect(requestAborted).toBe(true);
});

test("serve ignores wildcard abort frames whose payload requestId differs from subject", async () => {
  const fake = new FakeNatsConnection();
  let capturedSignal: AbortSignal | undefined;
  let releaseHandler!: () => void;
  const handlerReleased = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const server = await serve({
    connection: asNats(fake),
    hostname: "abort-mismatch.test",
    fetch: async (request) => {
      capturedSignal = request.signal;
      await handlerReleased;
      return new Response("ok");
    },
  });
  const subjectsA = buildTunnelSubjects("abort-mismatch.test", "req_a");
  const subjectsB = buildTunnelSubjects("abort-mismatch.test", "req_b");

  fake.publish(
    subjectsB.request,
    encodeTunnelFrame({
      type: "request.start",
      protocol: "tunnel.v1",
      requestId: "req_b",
      method: "GET",
      url: "/",
      headers: [],
      replySubject: subjectsB.reply,
      abortSubject: subjectsB.abort,
    }),
  );
  await waitForPublished(fake, "response.ack");

  fake.publish(
    subjectsA.abort,
    encodeTunnelFrame({
      type: "abort",
      requestId: "req_b",
      reason: "wrong subject",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(capturedSignal?.aborted).toBe(false);
  releaseHandler();
  await waitForPublished(fake, "response.start");
  await server.close();
});

test("serve dedupes repeated request.start frames for the same requestId", async () => {
  const fake = new FakeNatsConnection();
  let handlerCalls = 0;
  let releaseHandler!: () => void;
  const handlerReleased = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const server = await serve({
    connection: asNats(fake),
    hostname: "dedupe-start.test",
    fetch: async () => {
      handlerCalls++;
      await handlerReleased;
      return new Response("ok");
    },
  });
  const subjects = buildTunnelSubjects("dedupe-start.test", "req_dedupe");
  const startFrame = {
    type: "request.start",
    protocol: "tunnel.v1",
    requestId: "req_dedupe",
    method: "POST",
    url: "/",
    headers: [],
    replySubject: subjects.reply,
    abortSubject: subjects.abort,
    bodySubject: subjects.body,
  } satisfies RequestStartFrame;

  fake.publish(subjects.request, encodeTunnelFrame(startFrame));
  await waitForPublished(fake, "response.ack");
  fake.publish(subjects.request, encodeTunnelFrame(startFrame));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(handlerCalls).toBe(1);
  expect(
    fake.subscriptions.filter((entry) => entry.subject === subjects.body),
  ).toHaveLength(1);

  releaseHandler();
  await waitForPublished(fake, "response.start");
  await server.close();
});

test("serve subscribes to the host request subject with a hostname queue group", async () => {
  const fake = new FakeNatsConnection();
  const server = await serve({
    connection: asNats(fake),
    hostname: "queue.test",
    fetch: async () => new Response("ok"),
  });
  const subjects = buildTunnelSubjects("queue.test", "server");

  expect(fake.subscriptions).toContainEqual({
    subject: subjects.request,
    queue: "tunnel_v1_host_cXVldWUudGVzdA",
  });

  await server.close();
});
