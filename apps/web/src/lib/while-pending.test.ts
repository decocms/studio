import { describe, expect, test } from "bun:test";
import { whilePending } from "./while-pending";

function recorder() {
  const calls: boolean[] = [];
  return { calls, set: (pending: boolean) => calls.push(pending) };
}

describe("whilePending", () => {
  test("is pending while the task runs and returns its result", async () => {
    const pending = recorder();
    const result = await whilePending(pending.set, async () => {
      expect(pending.calls).toEqual([true]);
      return 42;
    });
    expect(result).toBe(42);
    expect(pending.calls).toEqual([true, false]);
  });

  test("clears pending when the task rejects", async () => {
    const pending = recorder();
    await expect(
      whilePending(pending.set, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(pending.calls).toEqual([true, false]);
  });

  test("clears pending when the task throws synchronously", async () => {
    const pending = recorder();
    await expect(
      whilePending(pending.set, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(pending.calls).toEqual([true, false]);
  });
});
