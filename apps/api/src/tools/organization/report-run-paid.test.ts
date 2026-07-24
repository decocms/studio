import { describe, expect, test } from "bun:test";
import { insufficientBalanceMessage } from "./report-run-paid";

describe("insufficientBalanceMessage", () => {
  test("carries the [CREDITS] prefix — wire contract with the frontend's credit-error detection", () => {
    expect(insufficientBalanceMessage(123)).toStartWith("[CREDITS] ");
  });

  test("formats both amounts as dollars", () => {
    expect(insufficientBalanceMessage(123)).toContain("$5.00");
    expect(insufficientBalanceMessage(123)).toContain("$1.23");
  });
});
