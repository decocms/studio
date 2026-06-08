/**
 * Unit tests for the run-abort registry.
 *
 * Pure logic — no HTTP, no DB, no mocks.  Co-located with the module under test.
 */
import { describe, expect, it } from "bun:test";
import { register, abort, unregister } from "./run-abort-registry";

describe("run-abort-registry", () => {
  it("register returns an AbortController whose signal is not yet aborted", () => {
    const ac = register("run-test-1");
    expect(ac.signal.aborted).toBe(false);
    // Cleanup so the Map stays clean between tests.
    unregister("run-test-1");
  });

  it("abort(runId) aborts the signal and returns true", () => {
    const ac = register("run-test-2");
    expect(ac.signal.aborted).toBe(false);

    const result = abort("run-test-2");

    expect(result).toBe(true);
    expect(ac.signal.aborted).toBe(true);

    unregister("run-test-2");
  });

  it("abort(unknown) returns false without throwing", () => {
    const result = abort("run-does-not-exist");
    expect(result).toBe(false);
  });

  it("unregister then abort returns false (no-op)", () => {
    const ac = register("run-test-3");
    unregister("run-test-3");

    const result = abort("run-test-3");
    expect(result).toBe(false);
    // Signal should not be aborted (abort was called after unregister).
    expect(ac.signal.aborted).toBe(false);
  });

  it("register overwrites a prior controller for the same runId", () => {
    const ac1 = register("run-test-4");
    const ac2 = register("run-test-4");

    // They are distinct controllers.
    expect(ac1).not.toBe(ac2);

    // abort targets the latest registration (ac2).
    abort("run-test-4");
    expect(ac2.signal.aborted).toBe(true);
    // ac1 was evicted from the registry; its signal is untouched.
    expect(ac1.signal.aborted).toBe(false);

    unregister("run-test-4");
  });
});
