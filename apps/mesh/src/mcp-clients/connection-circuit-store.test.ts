import { describe, expect, it } from "bun:test";
import {
  CONNECTION_DISABLE_FAILURE_THRESHOLD,
  CONNECTION_DISABLE_MIN_WINDOW_MS,
} from "../core/constants";
import {
  NoopConnectionCircuitStore,
  shouldDisableForRecord,
} from "./connection-circuit-store";

const T = CONNECTION_DISABLE_FAILURE_THRESHOLD;
const W = CONNECTION_DISABLE_MIN_WINDOW_MS;

describe("shouldDisableForRecord", () => {
  it("does not disable below the failure threshold", () => {
    expect(
      shouldDisableForRecord({
        count: T - 1,
        firstFailureAt: 0,
        lastFailureAt: W,
      }),
    ).toBe(false);
  });

  it("does not disable a burst that hasn't been sustained past the window", () => {
    // Count is well over threshold, but all failures landed in < window —
    // a thundering herd, not a sustained outage.
    expect(
      shouldDisableForRecord({
        count: T * 10,
        firstFailureAt: 0,
        lastFailureAt: W - 1,
      }),
    ).toBe(false);
  });

  it("disables once threshold is reached AND sustained past the window", () => {
    expect(
      shouldDisableForRecord({
        count: T,
        firstFailureAt: 0,
        lastFailureAt: W,
      }),
    ).toBe(true);
  });
});

describe("NoopConnectionCircuitStore", () => {
  it("never signals disable", async () => {
    const store = new NoopConnectionCircuitStore();
    const decision = await store.recordFailure();
    expect(decision.shouldDisable).toBe(false);
    // recordSuccess / teardown are no-ops that must not throw
    await store.recordSuccess();
    store.teardown();
  });
});
