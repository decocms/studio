import { describe, expect, test } from "bun:test";
import { isPermanentRunError, PermanentRunError } from "./dispatch-errors";

describe("isPermanentRunError", () => {
  test("recognizes a model_not_allowed PermanentRunError", () => {
    const err = new PermanentRunError(
      "model_not_allowed",
      "Model not allowed for your role",
    );
    expect(isPermanentRunError(err)).toBe(true);
  });

  test("does not treat a plain Error as permanent", () => {
    expect(isPermanentRunError(new Error("boom"))).toBe(false);
  });
});
