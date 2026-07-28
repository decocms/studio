import { describe, expect, test } from "bun:test";
import { isPartialNumericInput } from "./partial-number-input";

describe("isPartialNumericInput", () => {
  test("accepts in-progress and complete decimal input for number schemas", () => {
    for (const value of [
      "",
      "-",
      "+",
      ".",
      "0.",
      "1.5",
      "1e-",
      "1e+5",
      "-3.14",
    ]) {
      expect(isPartialNumericInput(value, false)).toBe(true);
    }
  });

  test("rejects a decimal point or exponent for integer schemas", () => {
    for (const value of ["1.5", "1.", ".5", "1e5", "1e-3"]) {
      expect(isPartialNumericInput(value, true)).toBe(false);
    }
  });

  test("accepts in-progress and complete whole-number input for integer schemas", () => {
    for (const value of ["", "-", "+", "0", "42", "-17"]) {
      expect(isPartialNumericInput(value, true)).toBe(true);
    }
  });
});
