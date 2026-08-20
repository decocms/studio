import { describe, expect, it } from "bun:test";
import {
  githubRetryAfterMs,
  isGithubRateLimited,
  readGithubRateLimit,
} from "./github-rate-limit";

const headers = (init: Record<string, string>) => new Headers(init);

describe("readGithubRateLimit", () => {
  it("reads the whole family", () => {
    expect(
      readGithubRateLimit(
        headers({
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4987",
          "x-ratelimit-reset": "1787236000",
          "x-ratelimit-used": "13",
          "x-ratelimit-resource": "core",
        }),
      ),
    ).toEqual({
      limit: 5000,
      remaining: 4987,
      reset: 1787236000,
      used: 13,
      resource: "core",
    });
  });

  it("nulls what the response did not carry", () => {
    expect(readGithubRateLimit(headers({}))).toEqual({
      limit: null,
      remaining: null,
      reset: null,
      used: null,
      resource: null,
    });
  });

  it("nulls a non-numeric value rather than reporting NaN", () => {
    expect(
      readGithubRateLimit(headers({ "x-ratelimit-remaining": "n/a" }))
        .remaining,
    ).toBeNull();
  });
});

describe("isGithubRateLimited", () => {
  it("treats 429 as a limit unconditionally", () => {
    expect(isGithubRateLimited({ status: 429, headers: headers({}) })).toBe(
      true,
    );
  });

  it("treats a 403 carrying retry-after as the secondary limit", () => {
    expect(
      isGithubRateLimited({
        status: 403,
        headers: headers({ "retry-after": "60" }),
      }),
    ).toBe(true);
  });

  it("treats a 403 with an exhausted window as the primary limit", () => {
    expect(
      isGithubRateLimited({
        status: 403,
        headers: headers({ "x-ratelimit-remaining": "0" }),
      }),
    ).toBe(true);
  });

  /**
   * A 403 for missing scopes is a permission problem. Reporting it as a rate
   * limit would tell the user to wait for a window that will never help.
   */
  it("does not treat a plain 403 as a limit", () => {
    expect(
      isGithubRateLimited({
        status: 403,
        headers: headers({ "x-ratelimit-remaining": "4999" }),
      }),
    ).toBe(false);
    expect(isGithubRateLimited({ status: 403, headers: headers({}) })).toBe(
      false,
    );
  });

  it("does not treat other failures as limits", () => {
    expect(isGithubRateLimited({ status: 404, headers: headers({}) })).toBe(
      false,
    );
    expect(isGithubRateLimited({ status: 500, headers: headers({}) })).toBe(
      false,
    );
  });
});

describe("githubRetryAfterMs", () => {
  const NOW = 1_787_236_000_000;

  it("reads retry-after as seconds", () => {
    expect(githubRetryAfterMs(headers({ "retry-after": "60" }), NOW)).toBe(
      60_000,
    );
  });

  it("falls back to the window reset, which is an absolute instant", () => {
    expect(
      githubRetryAfterMs(headers({ "x-ratelimit-reset": "1787236120" }), NOW),
    ).toBe(120_000);
  });

  it("prefers retry-after over the window reset", () => {
    expect(
      githubRetryAfterMs(
        headers({ "retry-after": "5", "x-ratelimit-reset": "1787236120" }),
        NOW,
      ),
    ).toBe(5_000);
  });

  it("never reports a negative wait for a window that already reset", () => {
    expect(
      githubRetryAfterMs(headers({ "x-ratelimit-reset": "1787235000" }), NOW),
    ).toBe(0);
  });

  it("is null when GitHub said nothing about when to come back", () => {
    expect(githubRetryAfterMs(headers({}), NOW)).toBeNull();
  });
});
