import { describe, expect, test } from "bun:test";
import {
  isTransientRunFailure,
  retryBudgetFor,
  TRANSIENT_RETRY_BUDGET,
  UNKNOWN_RETRY_BUDGET,
} from "./transient-failure";

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

  // Second burst, same cause, different symptom: the pod's preflight could not
  // reach Studio's MCP and refused to run. Nothing to do with the task.
  test("a pod that could not reach Studio's MCP is infrastructure", () => {
    expect(
      isTransientRunFailure({
        kind: "error",
        errorText:
          "Error: harness_crashed: studio MCP is unusable " +
          "(http://192.168.5.2:3000/api/org/mcp/task-run/thrd_x): studio=failed. " +
          "The harness cannot act on Studio; refusing to run rather than return " +
          "a result that changed nothing.",
      }),
    ).toBe(true);
  });

  test("a stream that died mid-run is infrastructure", () => {
    expect(
      isTransientRunFailure({
        kind: "error",
        errorText: "Error: harness_crashed: unexpected EOF",
      }),
    ).toBe(true);
  });

  // Same burst again: the DB pool, not the task. Both the server's refusal and
  // pg-pool timing out waiting for one of its own connections.
  test("running out of database connections is infrastructure", () => {
    for (const errorText of [
      "error: sorry, too many clients already",
      "Error: timeout exceeded when trying to connect",
    ]) {
      expect(isTransientRunFailure({ kind: "error", errorText })).toBe(true);
    }
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

describe("retryBudgetFor", () => {
  test("recognized infrastructure gets the full budget", () => {
    expect(
      retryBudgetFor({
        kind: "error",
        errorText: "Sandbox did not become ready within 180 seconds",
      }),
    ).toBe(TRANSIENT_RETRY_BUDGET);
  });

  // The policy that matters: three previously-unseen infrastructure messages
  // showed up across two bursts, and parking those was how a card silently
  // stopped moving. An unrecognized failure gets one benefit of the doubt; a
  // genuine agent error reproduces and lands in To Do one attempt later.
  test("an unrecognized failure gets exactly one attempt, not zero", () => {
    expect(
      retryBudgetFor({
        kind: "error",
        errorText: "TypeError: cannot read property 'map' of undefined",
      }),
    ).toBe(UNKNOWN_RETRY_BUDGET);
    expect(UNKNOWN_RETRY_BUDGET).toBeGreaterThan(0);
  });

  test("a deliberate cancel gets none", () => {
    for (const kind of ["cancelled", "superseded"]) {
      expect(retryBudgetFor({ kind })).toBe(0);
    }
  });

  // A budget, not a boolean — a permanently broken cluster has to terminate.
  test("every budget is finite", () => {
    expect(TRANSIENT_RETRY_BUDGET).toBeLessThan(10);
  });
});
