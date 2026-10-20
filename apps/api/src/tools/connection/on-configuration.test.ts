import { describe, expect, test } from "bun:test";
import { onConfigurationError } from "./on-configuration";

describe("onConfigurationError", () => {
  test("returns null when the call succeeded", () => {
    expect(onConfigurationError(false, undefined)).toBeNull();
    expect(onConfigurationError(undefined, undefined)).toBeNull();
  });

  test("returns an error carrying the downstream's message on isError", () => {
    const error = onConfigurationError(true, [
      { type: "text", text: "scope validation failed" },
    ]);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("scope validation failed");
  });

  test("falls back to a generic message when no text content is present", () => {
    const error = onConfigurationError(true, []);

    expect(error?.message).toContain("unknown error");
  });
});
