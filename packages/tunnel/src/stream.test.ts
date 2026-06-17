import { expect, test } from "bun:test";

import {
  base64UrlDecode,
  base64UrlEncode,
  createAsyncFrameQueue,
} from "./stream";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const trackPromise = <T>(promise: Promise<T>) => {
  let state:
    | { status: "pending" }
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; reason: unknown } = { status: "pending" };

  promise.then(
    (value) => {
      state = { status: "fulfilled", value };
    },
    (reason) => {
      state = { status: "rejected", reason };
    },
  );

  return async () => {
    await flushMicrotasks();
    return state;
  };
};

const expectSettlesPromptly = async <T>(promise: Promise<T>): Promise<T> => {
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    promise,
    new Promise<typeof timeout>((resolve) => {
      setTimeout(() => resolve(timeout), 25);
    }),
  ]);

  if (result === timeout) {
    throw new Error("promise did not settle promptly");
  }

  return result;
};

test("base64url helpers preserve arbitrary binary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);

  expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
});

test("base64url output omits reserved characters and padding", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);

  expect(base64UrlEncode(bytes)).not.toMatch(/[+/=]/u);
});

test("base64url helpers preserve larger binary payloads", () => {
  const bytes = new Uint8Array(128 * 1024);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (index * 31 + 17) % 256;
  }

  const encoded = base64UrlEncode(bytes);

  expect(encoded).not.toMatch(/[+/=]/u);
  expect(base64UrlDecode(encoded)).toEqual(bytes);
});

test("async frame queue yields pre-pushed values in order", async () => {
  const queue = createAsyncFrameQueue<number>();

  queue.push(1);
  queue.push(2);
  queue.close();

  const values: number[] = [];
  for await (const value of queue) {
    values.push(value);
  }

  expect(values).toEqual([1, 2]);
});

test("async frame queue yields values pushed after iteration starts", async () => {
  const queue = createAsyncFrameQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  const next = iterator.next();

  queue.push(1);

  expect(await next).toEqual({ value: 1, done: false });
});

test("async frame queue iterator return settles pending next promptly", async () => {
  const queue = createAsyncFrameQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  const next = iterator.next();

  if (!iterator.return) {
    throw new Error("iterator return is missing");
  }

  expect(await expectSettlesPromptly(iterator.return())).toEqual({
    value: undefined,
    done: true,
  });
  expect(await next).toEqual({ value: undefined, done: true });
});

test("async frame queue iterator return settles all pending next calls", async () => {
  const queue = createAsyncFrameQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  const first = iterator.next();
  const second = iterator.next();

  if (!iterator.return) {
    throw new Error("iterator return is missing");
  }

  expect(await expectSettlesPromptly(iterator.return())).toEqual({
    value: undefined,
    done: true,
  });
  expect(await expectSettlesPromptly(first)).toEqual({
    value: undefined,
    done: true,
  });
  expect(await expectSettlesPromptly(second)).toEqual({
    value: undefined,
    done: true,
  });

  queue.push(1);

  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});

test("async frame queue push wakes one waiting iterator per value", async () => {
  const queue = createAsyncFrameQueue<number>();
  const first = trackPromise(queue[Symbol.asyncIterator]().next());
  const second = trackPromise(queue[Symbol.asyncIterator]().next());

  queue.push(1);

  expect(await first()).toEqual({
    status: "fulfilled",
    value: { value: 1, done: false },
  });
  expect(await second()).toEqual({ status: "pending" });

  queue.push(2);

  expect(await second()).toEqual({
    status: "fulfilled",
    value: { value: 2, done: false },
  });
});

test("async frame queue close drains buffered values before ending", async () => {
  const queue = createAsyncFrameQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();

  queue.push(1);
  queue.push(2);
  queue.close();

  expect(await iterator.next()).toEqual({ value: 1, done: false });
  expect(await iterator.next()).toEqual({ value: 2, done: false });
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});

test("async frame queue close wakes all waiting iterators", async () => {
  const queue = createAsyncFrameQueue<number>();
  const first = trackPromise(queue[Symbol.asyncIterator]().next());
  const second = trackPromise(queue[Symbol.asyncIterator]().next());

  queue.close();

  expect(await first()).toEqual({
    status: "fulfilled",
    value: { value: undefined, done: true },
  });
  expect(await second()).toEqual({
    status: "fulfilled",
    value: { value: undefined, done: true },
  });
});

test("async frame queue propagates errors after draining buffered values", async () => {
  const queue = createAsyncFrameQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  const error = new Error("boom");

  queue.push(1);
  queue.fail(error);

  expect(await iterator.next()).toEqual({ value: 1, done: false });
  await expect(iterator.next()).rejects.toThrow(error);
});

test("async frame queue fail wakes all waiting iterators", async () => {
  const queue = createAsyncFrameQueue<number>();
  const error = new Error("boom");
  const first = trackPromise(queue[Symbol.asyncIterator]().next());
  const second = trackPromise(queue[Symbol.asyncIterator]().next());

  queue.fail(error);

  expect(await first()).toEqual({ status: "rejected", reason: error });
  expect(await second()).toEqual({ status: "rejected", reason: error });
});

test("async frame queue ignores pushes after close or fail", async () => {
  const closedQueue = createAsyncFrameQueue<number>();
  closedQueue.close();
  closedQueue.push(1);

  const closedValues: number[] = [];
  for await (const value of closedQueue) {
    closedValues.push(value);
  }

  const failedQueue = createAsyncFrameQueue<number>();
  failedQueue.fail(new Error("failed"));
  failedQueue.push(1);

  const iterator = failedQueue[Symbol.asyncIterator]();

  expect(closedValues).toEqual([]);
  await expect(iterator.next()).rejects.toThrow("failed");
});
