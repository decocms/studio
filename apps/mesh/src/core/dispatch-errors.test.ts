import { describe, expect, it } from "bun:test";
import { PermanentRunError, isPermanentRunError } from "./dispatch-errors";

describe("isPermanentRunError", () => {
  it("matches a PermanentRunError instance", () => {
    expect(
      isPermanentRunError(new PermanentRunError("empty_request", "no msg")),
    ).toBe(true);
    expect(
      isPermanentRunError(new PermanentRunError("agent_not_found", "gone")),
    ).toBe(true);
  });

  it("matches the deserialized shape (flag, not instanceof)", () => {
    const deserialized = Object.assign(new Error("Agent not found"), {
      name: "PermanentRunError",
      permanent: true,
      code: "agent_not_found",
    });
    expect(deserialized instanceof PermanentRunError).toBe(false);
    expect(isPermanentRunError(deserialized)).toBe(true);
  });

  it("rejects ordinary errors and non-errors", () => {
    expect(isPermanentRunError(new Error("transient db blip"))).toBe(false);
    expect(isPermanentRunError({ permanent: false })).toBe(false);
    expect(isPermanentRunError(null)).toBe(false);
    expect(isPermanentRunError("Agent not found")).toBe(false);
  });
});
