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

  // Claude Code APICallError shape: generic message + stale info in data.stderr
  it("matches claude-code APICallError with stale message in data.stderr", () => {
    const err = Object.assign(new Error("process exited with code 1"), {
      data: { stderr: "No conversation found with session ID abc123" },
    });
    expect(isStaleSessionError(err)).toBe(true);
  });

  // Claude Code shape with stale message in err.stderr directly
  it("matches claude-code error with stale message in err.stderr", () => {
    const err = Object.assign(new Error("process exited with code 1"), {
      stderr: "No conversation found with session ID abc123",
    });
    expect(isStaleSessionError(err)).toBe(true);
  });

  // Stale message carried in err.cause
  it("matches when stale message is in err.cause.message", () => {
    const cause = new Error("No conversation found with session ID abc123");
    const err = new Error("process exited with code 1");
    // @ts-ignore - setting cause manually for test
    err.cause = cause;
    expect(isStaleSessionError(err)).toBe(true);
  });

  // Stale message in err.cause.stderr
  it("matches when stale message is in err.cause.stderr", () => {
    const cause = Object.assign(new Error("exit code 1"), {
      stderr: "No conversation found with session ID abc123",
    });
    const err = new Error("process exited with code 1");
    // @ts-ignore - setting cause manually for test
    err.cause = cause;
    expect(isStaleSessionError(err)).toBe(true);
  });

  // Negative: unrelated data/stderr should not match
  it("is false when data.stderr contains only unrelated content", () => {
    const err = Object.assign(new Error("process exited with code 1"), {
      data: { stderr: "network timeout connecting to server" },
    });
    expect(isStaleSessionError(err)).toBe(false);
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
