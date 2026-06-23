import { describe, expect, test } from "bun:test";
import {
  abortBackgroundJobs,
  registerBackgroundAbort,
  unregisterBackgroundAbort,
} from "./background-abort-registry";

describe("background-abort-registry", () => {
  test("abortBackgroundJobs aborts every controller registered for the thread", () => {
    const a = registerBackgroundAbort("t1");
    const b = registerBackgroundAbort("t1");
    const other = registerBackgroundAbort("t2");

    abortBackgroundJobs("t1");

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);

    abortBackgroundJobs("t2");
    expect(other.signal.aborted).toBe(true);
  });

  test("abortBackgroundJobs is a no-op for an unknown thread", () => {
    expect(() => abortBackgroundJobs("nope")).not.toThrow();
  });

  test("unregistered controllers are no longer aborted", () => {
    const ac = registerBackgroundAbort("t3");
    unregisterBackgroundAbort("t3", ac);
    abortBackgroundJobs("t3");
    expect(ac.signal.aborted).toBe(false);
  });
});
