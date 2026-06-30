import { describe, expect, it } from "bun:test";
import { isTerminalStatus } from "./consume-run-projection";

describe("isTerminalStatus", () => {
  it("is true for completed/failed/requires_action (run is over for the consumer)", () => {
    // The entry guard returns on these — consume already wrote them.
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("requires_action")).toBe(true);
    expect(isTerminalStatus("in_progress")).toBe(false);
  });
});
