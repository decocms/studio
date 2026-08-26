import { describe, expect, test } from "bun:test";
import { isTransientJsApiError } from "./transient-js-error";

describe("isTransientJsApiError", () => {
  test.each([
    "stream is offline",
    "consumer is offline",
    "JetStream is not enabled",
    "no responders available for request",
    "503 service unavailable",
  ])("%s is transient", (message) => {
    expect(isTransientJsApiError(new Error(message))).toBe(true);
  });

  test("a TimeoutError is transient regardless of message", () => {
    const err = new Error("whatever");
    err.name = "TimeoutError";
    expect(isTransientJsApiError(err)).toBe(true);
  });

  test.each([
    "stream not found",
    "consumer not found",
    "invalid stream config",
    "wrong last sequence: 4",
  ])("%s is permanent", (message) => {
    expect(isTransientJsApiError(new Error(message))).toBe(false);
  });

  test("a non-Error is not retried", () => {
    expect(isTransientJsApiError("stream is offline")).toBe(false);
  });
});
