import { afterEach, describe, expect, it } from "bun:test";
import {
  enqueueGroupThreadsFetch,
  resetGroupThreadsFetchQueueForTests,
} from "./group-threads-fetch-queue";

afterEach(() => {
  resetGroupThreadsFetchQueueForTests();
});

describe("enqueueGroupThreadsFetch", () => {
  it("runs tasks and resolves results", async () => {
    const value = await enqueueGroupThreadsFetch(async () => 42);
    expect(value).toBe(42);
  });

  it("limits concurrent executions to four", async () => {
    let peak = 0;
    let active = 0;

    const tasks = Array.from({ length: 8 }, () =>
      enqueueGroupThreadsFetch(async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(0);
        active--;
        return 1;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
