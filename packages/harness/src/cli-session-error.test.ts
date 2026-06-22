import { describe, expect, it } from "bun:test";
import {
  CliSessionExpiredError,
  isStaleSessionError,
} from "./cli-session-error";

describe("isStaleSessionError", () => {
  it("matches codex stale-thread message", () => {
    expect(
      isStaleSessionError(
        new Error(
          "Thread 'abc' not found after server restart. Create a new thread by omitting threadId.",
        ),
      ),
    ).toBe(true);
  });
  it("matches generic 'thread not found'", () => {
    expect(isStaleSessionError(new Error("thread xyz not found"))).toBe(true);
  });
  it("matches claude-code 'no conversation found'", () => {
    expect(
      isStaleSessionError(new Error("No conversation found with session id")),
    ).toBe(true);
  });
  it("is false for unrelated errors", () => {
    expect(isStaleSessionError(new Error("network timeout"))).toBe(false);
  });
  it("is false for non-errors", () => {
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe("CliSessionExpiredError", () => {
  it("has a stable name and default message", () => {
    const e = new CliSessionExpiredError();
    expect(e.name).toBe("CliSessionExpiredError");
    expect(e.message).toBe("Session expired — start a new thread.");
  });
  it("carries a cause", () => {
    const cause = new Error("thread not found");
    expect(new CliSessionExpiredError(cause).cause).toBe(cause);
  });
});
