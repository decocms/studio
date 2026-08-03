import { describe, expect, test } from "bun:test";
import { parseErrorMessage } from "./parse-error-message";

describe("parseErrorMessage", () => {
  test("surfaces sandbox bring-up failures with a specific summary, not the generic timeout text", () => {
    // Shape the daemon emits (via the `handler_error` frame) on a config timeout.
    const raw =
      "handler_error: sandbox failed to start: configuration timed out";
    const result = parseErrorMessage(raw);

    // Must NOT collapse into the generic timeout bucket even though the
    // message contains "timed out".
    expect(result.summary).not.toBe(
      "That took longer than expected. Try again.",
    );
    expect(result.summary.toLowerCase()).toContain("sandbox");
    expect(result.summary).toContain("configuration timed out");
    expect(result.rawDetails).toBe(raw);
  });

  test("uses a generic sandbox summary when no cause clause is present", () => {
    const result = parseErrorMessage("sandbox failed to start");
    expect(result.summary.toLowerCase()).toContain("sandbox");
    expect(result.summary).not.toContain("(");
    expect(result.rawDetails).toBe("sandbox failed to start");
  });

  test("still classifies a plain timeout (no sandbox marker) as the generic timeout", () => {
    const result = parseErrorMessage("handler_error: The operation timed out.");
    expect(result.summary).toBe("That took longer than expected. Try again.");
  });

  test("passes through a plain, short error message unchanged", () => {
    const result = parseErrorMessage("Something broke");
    expect(result.summary).toBe("Something broke");
    expect(result.rawDetails).toBeNull();
  });
});
