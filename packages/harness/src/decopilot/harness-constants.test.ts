import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_TOKENS } from "./harness-constants";

describe("harness-constants", () => {
  it("exposes the default max tokens", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(32768);
  });
});
