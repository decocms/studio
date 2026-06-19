import { describe, expect, it } from "bun:test";
import { deriveTerminalThreadStatus } from "./thread-status";

describe("deriveTerminalThreadStatus", () => {
  it("maps stream finish reasons to non-running thread statuses", () => {
    expect(deriveTerminalThreadStatus("stop", [])).toBe("completed");
    expect(
      deriveTerminalThreadStatus("stop", [{ type: "text", text: "Ok?" }]),
    ).toBe("requires_action");
    expect(
      deriveTerminalThreadStatus("tool-calls", [
        { type: "tool-user_ask", state: "input-available" },
      ]),
    ).toBe("requires_action");
    expect(
      deriveTerminalThreadStatus("tool-calls", [
        { type: "tool-user_ask", state: "output-available" },
      ]),
    ).toBe("completed");
    expect(deriveTerminalThreadStatus(undefined, [])).toBe("failed");
  });
});
