import { describe, expect, test } from "bun:test";
import { createKeyedSerialTaskQueue } from "./serial-task-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("keyed serial task queue", () => {
  test("serializes submissions from separate component lifetimes", async () => {
    const queue = createKeyedSerialTaskQueue();
    const unmountedSave = deferred<string>();
    const started: string[] = [];

    const first = queue.run("org-1/project-1", async () => {
      started.push("unmounted component");
      return unmountedSave.promise;
    });
    const remounted = queue.run("org-1/project-1", async () => {
      started.push("remounted component");
      return "saved latest";
    });

    await Promise.resolve();
    expect(started).toEqual(["unmounted component"]);

    unmountedSave.resolve("saved old");
    expect(await first).toBe("saved old");
    expect(await remounted).toBe("saved latest");
    expect(started).toEqual(["unmounted component", "remounted component"]);
  });

  test("keeps different projects parallel", async () => {
    const queue = createKeyedSerialTaskQueue();
    const blocked = deferred<void>();
    const started: string[] = [];

    const firstProject = queue.run("org-1/project-1", async () => {
      started.push("project-1");
      return blocked.promise;
    });
    const secondProject = queue.run("org-1/project-2", async () => {
      started.push("project-2");
    });

    await secondProject;
    expect(started).toEqual(["project-1", "project-2"]);
    blocked.resolve();
    await firstProject;
  });

  test("continues after rejection and removes a drained key", async () => {
    const queue = createKeyedSerialTaskQueue();
    const firstResult = deferred<string>();

    const first = queue.run("org-1/project-1", () => firstResult.promise);
    const second = queue.run("org-1/project-1", async () => "saved latest");

    await Promise.resolve();
    expect(queue.activeKeyCount()).toBe(1);
    firstResult.reject(new Error("save failed"));
    await expect(first).rejects.toThrow("save failed");
    expect(await second).toBe("saved latest");
    await Promise.resolve();
    expect(queue.activeKeyCount()).toBe(0);
  });
});
