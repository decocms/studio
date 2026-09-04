import { describe, expect, test } from "bun:test";
import { LatestWriteQueue, WriteQueueFencedError } from "./latest-write-queue";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestWriteQueue", () => {
  test("serializes a key and coalesces queued values to the newest", async () => {
    const queue = new LatestWriteQueue<string, string>();
    const releaseFirst = deferred();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const write = async (value: string) => {
      started.push(value);
      active++;
      maxActive = Math.max(maxActive, active);
      if (value === "first") await releaseFirst.promise;
      active--;
    };

    const first = queue.enqueue("file.ts", "first", write);
    const superseded = queue.enqueue("file.ts", "intermediate", write);
    const newest = queue.enqueue("file.ts", "newest", write);
    expect(started).toEqual(["first"]);

    releaseFirst.resolve();
    await Promise.all([first, superseded, newest]);
    expect(started).toEqual(["first", "newest"]);
    expect(maxActive).toBe(1);
  });

  test("continues with the newest queued value after a failed write", async () => {
    const queue = new LatestWriteQueue<string, string>();
    const releaseFirst = deferred();
    const started: string[] = [];
    const first = queue.enqueue("file.ts", "fails", async (value) => {
      started.push(value);
      await releaseFirst.promise;
      throw new Error("write failed");
    });
    const newest = queue.enqueue("file.ts", "recovers", async (value) => {
      started.push(value);
    });

    releaseFirst.resolve();
    await expect(first).rejects.toThrow("write failed");
    await expect(newest).resolves.toBeUndefined();
    expect(started).toEqual(["fails", "recovers"]);
  });

  test("allows independent paths to write concurrently", async () => {
    const queue = new LatestWriteQueue<string, string>();
    const release = deferred();
    const started: string[] = [];
    const write = async (value: string) => {
      started.push(value);
      await release.promise;
    };

    const first = queue.enqueue("a.ts", "a", write);
    const second = queue.enqueue("b.ts", "b", write);
    expect(started).toEqual(["a", "b"]);
    release.resolve();
    await Promise.all([first, second]);
  });

  test("fences a path set, drains accepted writes, then runs the mutation", async () => {
    const queue = new LatestWriteQueue<string, string>();
    const releaseWrite = deferred();
    const mutationStarted = deferred();
    const releaseMutation = deferred();
    const events: string[] = [];
    const existingWrite = queue.enqueue("/src/a.ts", "old path", async () => {
      events.push("write:start");
      await releaseWrite.promise;
      events.push("write:end");
    });

    const mutation = queue.withFence(
      (path) => path === "/src" || path.startsWith("/src/"),
      async () => {
        events.push("mutation:start");
        mutationStarted.resolve();
        await expect(
          queue.enqueue("/src/b.ts", "blocked", async () => {}),
        ).rejects.toBeInstanceOf(WriteQueueFencedError);
        await releaseMutation.promise;
        events.push("mutation:end");
      },
    );
    await expect(
      queue.enqueue("/src/c.ts", "blocked", async () => {}),
    ).rejects.toBeInstanceOf(WriteQueueFencedError);
    expect(events).toEqual(["write:start"]);

    releaseWrite.resolve();
    await existingWrite;
    await mutationStarted.promise;
    expect(events).toEqual(["write:start", "write:end", "mutation:start"]);
    releaseMutation.resolve();
    await mutation;

    await queue.enqueue("/src/after.ts", "allowed", async () => {
      events.push("write:after");
    });
    expect(events).toEqual([
      "write:start",
      "write:end",
      "mutation:start",
      "mutation:end",
      "write:after",
    ]);
  });

  test("serializes overlapping filesystem mutations", async () => {
    const queue = new LatestWriteQueue<string, string>();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const events: string[] = [];

    const first = queue.withFence(
      (path) => path.startsWith("/src/"),
      async () => {
        events.push("first:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        events.push("first:end");
      },
    );
    await firstStarted.promise;
    const second = queue.withFence(
      (path) => path.startsWith("/src/"),
      async () => {
        events.push("second:start");
        secondStarted.resolve();
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst.resolve();
    await first;
    await secondStarted.promise;
    await second;
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});
