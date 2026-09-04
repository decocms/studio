import { describe, expect, it } from "bun:test";
import { GitProviderError } from "../types";
import {
  repoErrorStatus,
  repoRateLimitRetryAfterMs,
  RepoWriteConflict,
} from "./types";

describe("repoErrorStatus", () => {
  it("reads the status off either provider's error", () => {
    expect(
      repoErrorStatus(
        new GitProviderError({
          provider: "gitlab",
          status: 409,
          message: "conflict",
        }),
      ),
    ).toBe(409);
    expect(repoErrorStatus({ status: 404 })).toBe(404);
  });

  it("is null for anything that does not carry one", () => {
    expect(repoErrorStatus(new Error("boom"))).toBeNull();
    expect(repoErrorStatus(new RepoWriteConflict("moved"))).toBeNull();
    expect(repoErrorStatus({ status: "409" })).toBeNull();
    expect(repoErrorStatus(null)).toBeNull();
    expect(repoErrorStatus(undefined)).toBeNull();
  });
});

describe("repoRateLimitRetryAfterMs", () => {
  it("distinguishes a rate refusal without a hint from a non-rate failure", () => {
    expect(
      repoRateLimitRetryAfterMs({ isRateLimited: true, retryAfterMs: 30_000 }),
    ).toBe(30_000);
    // A primary limit reports no wait; still a rate refusal.
    expect(
      repoRateLimitRetryAfterMs({ isRateLimited: true, retryAfterMs: null }),
    ).toBeNull();
    expect(repoRateLimitRetryAfterMs({ status: 403 })).toBeUndefined();
    expect(repoRateLimitRetryAfterMs(new Error("boom"))).toBeUndefined();
  });

  it("recognises a rate-limited GitProviderError", () => {
    const err = new GitProviderError({
      provider: "github",
      status: 429,
      message: "slow down",
      retryAfterMs: 1_000,
    });
    expect(err.isRateLimited).toBe(true);
    expect(repoRateLimitRetryAfterMs(err)).toBe(1_000);
  });
});
