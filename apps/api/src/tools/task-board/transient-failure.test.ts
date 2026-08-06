import { describe, expect, test } from "bun:test";
import { isTransientRunFailure } from "./transient-failure";

describe("isTransientRunFailure", () => {
  // The failure that stranded eight cards In Review at once: the local cluster
  // could not bring up eight sandboxes, so no run ever started.
  test("the sandbox-readiness timeout is infrastructure", () => {
    expect(
      isTransientRunFailure({
        kind: "error",
        errorText: "Error: Sandbox did not become ready within 180 seconds",
      }),
    ).toBe(true);
  });

  test("kinds that are infrastructure by construction need no message", () => {
    for (const kind of ["stall", "liveness", "projection", "abandoned"]) {
      expect(isTransientRunFailure({ kind })).toBe(true);
    }
  });

  test("a deliberate human act is never retried, whatever the message says", () => {
    for (const kind of ["cancelled", "superseded"]) {
      expect(
        isTransientRunFailure({
          kind,
          errorText: "Sandbox did not become ready within 180 seconds",
        }),
      ).toBe(false);
    }
  });

  // The whole point of the split: retrying this would burn a run reproducing it.
  test("an error the agent produced is not retried", () => {
    expect(
      isTransientRunFailure({
        kind: "error",
        errorText: "TypeError: cannot read property 'map' of undefined",
      }),
    ).toBe(false);
    expect(isTransientRunFailure({ kind: "error", errorText: null })).toBe(
      false,
    );
    expect(isTransientRunFailure({ kind: null })).toBe(false);
  });
});
