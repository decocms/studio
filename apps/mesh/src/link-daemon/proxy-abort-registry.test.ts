/**
 * Unit tests for the proxy-abort registry (Phase C-bis S2).
 *
 * Pure logic — no HTTP, no DB, no mocks. Co-located with the module under test.
 * Mirrors run-abort-registry.test.ts but the key is a reqId.
 */
import { describe, expect, it } from "bun:test";
import { register, abort, unregister, size } from "./proxy-abort-registry";

describe("proxy-abort-registry", () => {
  it("register returns an AbortController whose signal is not yet aborted", () => {
    const ac = register("req-test-1")!;
    expect(ac.signal.aborted).toBe(false);
    unregister("req-test-1");
  });

  it("abort(reqId) aborts the signal and returns true", () => {
    const ac = register("req-test-2")!;
    expect(ac.signal.aborted).toBe(false);

    const result = abort("req-test-2");

    expect(result).toBe(true);
    expect(ac.signal.aborted).toBe(true);

    unregister("req-test-2");
  });

  it("abort(unknown) returns false without throwing", () => {
    expect(abort("req-does-not-exist")).toBe(false);
  });

  it("unregister then abort returns false (no-op)", () => {
    const ac = register("req-test-3")!;
    unregister("req-test-3");

    expect(abort("req-test-3")).toBe(false);
    expect(ac.signal.aborted).toBe(false);
  });

  it("register returns null for a reqId already in-flight (idempotent-delivery dedup)", () => {
    // The cluster re-publishes the SAME reqId (request-leg tolerance) so a
    // dropped publish gets retried. A duplicate copy that races the in-flight
    // handler must NOT register a second controller — processing it again would
    // double-execute the request. The second register is a no-op returning null.
    const ac1 = register("req-test-4");
    expect(ac1).not.toBeNull();

    const ac2 = register("req-test-4");
    expect(ac2).toBeNull();

    // The original controller is untouched (still the live one to abort).
    expect(abort("req-test-4")).toBe(true);
    expect(ac1!.signal.aborted).toBe(true);

    // Once the in-flight request finishes and unregisters, the id is free again.
    unregister("req-test-4");
    const ac3 = register("req-test-4");
    expect(ac3).not.toBeNull();
    unregister("req-test-4");
  });

  it("size reflects registered entries and drops to zero after unregister", () => {
    const before = size();
    register("req-size-a");
    register("req-size-b");
    expect(size()).toBe(before + 2);
    unregister("req-size-a");
    unregister("req-size-b");
    expect(size()).toBe(before);
  });

  it("unregister of an aborted reqId frees the slot (cancel→release path)", () => {
    // Models the cancel reconciliation: abort fires the signal (which releases
    // handleStream's reader + runs acquireDispatch's release), then the handler
    // finally-block unregisters. The Map must not retain the entry afterwards.
    const ac = register("req-cancel-flow")!;
    abort("req-cancel-flow");
    expect(ac.signal.aborted).toBe(true);
    unregister("req-cancel-flow");
    expect(abort("req-cancel-flow")).toBe(false);
  });
});
