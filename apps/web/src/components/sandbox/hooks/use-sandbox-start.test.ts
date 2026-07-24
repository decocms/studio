import { describe, expect, it } from "bun:test";
import { isRetryableSandboxStartError } from "./use-sandbox-start";

// Pins the retry predicate to the exact "retry shortly" marker the server
// appends to transient lifecycle/lock errors (apps/api/src/storage/
// agent-sandbox-sessions.ts + *-runner-state.ts). If that contract drifts,
// this fails instead of silently reverting to surfacing the error.
describe("isRetryableSandboxStartError", () => {
  it("retries the server's transient lifecycle/lock errors", () => {
    for (const message of [
      "agent sandbox lifecycle transition in progress for vir_x/staging; retry shortly",
      "agent sandbox lifecycle lock busy >90000ms for vir_x/staging; retry shortly",
      "sandbox advisory lock busy >90000ms for user=u projectRef=p kind=agent-sandbox — provisioner is slow or stuck; retry shortly",
    ]) {
      expect(isRetryableSandboxStartError(new Error(message))).toBe(true);
    }
  });

  it("does not retry real boot failures or user-driven stops", () => {
    for (const message of [
      "Sandbox start was superseded by a stop",
      "Sandbox did not become ready within 180 seconds",
      "tunnel_no_first_frame: no response frame arrived before firstFrameTimeoutMs",
      "Virtual MCP not found",
    ]) {
      expect(isRetryableSandboxStartError(new Error(message))).toBe(false);
    }
  });
});
