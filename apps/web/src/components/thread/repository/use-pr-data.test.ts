import { describe, expect, test } from "bun:test";

import { StudioToolError } from "@/lib/studio-tools";
import {
  githubRateLimitWaitMs,
  prStatePollInterval,
  rateLimitCooldownMs,
} from "./use-pr-data.ts";

const NOW = 1_000_000;

const rateLimited = (message: string) => new StudioToolError(message, 500);

function changeRequest(state: "open" | "closed" | "merged") {
  return {
    changeRequest: {
      number: 1,
      url: "https://github.com/example/site/pull/1",
      title: "t",
      body: "",
      state,
      draft: false,
      mergedAt: null,
      base: "main",
      head: "draft",
      headSha: "abc",
      headRepoPath: "example/site",
      author: "someone",
      conflicting: false,
      checks: null,
      changedFiles: 1,
      checkRuns: [],
      comments: [],
      unresolvedConversations: 0,
      reviewBlocked: false,
    },
  };
}

describe("githubRateLimitWaitMs", () => {
  test("reads the wait a primary refusal names", () => {
    expect(
      githubRateLimitWaitMs(
        rateLimited("GitHub primary rate limit reached; retry in 4s"),
      ),
    ).toBe(4_000);
  });

  test("assumes a minute when a secondary refusal names none", () => {
    expect(
      githubRateLimitWaitMs(rateLimited("GitHub secondary rate limit reached")),
    ).toBe(60_000);
  });

  test("ignores other tool failures and non-tool errors", () => {
    expect(githubRateLimitWaitMs(rateLimited("Upstream failed"))).toBeNull();
    expect(
      githubRateLimitWaitMs(
        new Error("GitHub primary rate limit reached; retry in 4s"),
      ),
    ).toBeNull();
    expect(githubRateLimitWaitMs(null)).toBeNull();
  });
});

describe("rateLimitCooldownMs", () => {
  test("counts down from when the refusal landed", () => {
    const state = {
      error: rateLimited("GitHub primary rate limit reached; retry in 120s"),
      errorUpdatedAt: NOW - 30_000,
    };
    expect(rateLimitCooldownMs(state, NOW)).toBe(90_000);
    expect(rateLimitCooldownMs(state, NOW + 90_000)).toBe(0);
  });

  test("is zero without a rate-limit error", () => {
    expect(rateLimitCooldownMs({ error: null, errorUpdatedAt: 0 }, NOW)).toBe(
      0,
    );
  });
});

describe("prStatePollInterval", () => {
  const ok = { error: null, errorUpdatedAt: 0 };

  test("polls an open change request every minute", () => {
    expect(
      prStatePollInterval({ ...ok, data: changeRequest("open") }, NOW),
    ).toBe(60_000);
  });

  test("polls slowly without an open change request", () => {
    expect(
      prStatePollInterval({ ...ok, data: { changeRequest: null } }, NOW),
    ).toBe(300_000);
    expect(
      prStatePollInterval({ ...ok, data: changeRequest("merged") }, NOW),
    ).toBe(300_000);
    expect(
      prStatePollInterval({ ...ok, data: changeRequest("closed") }, NOW),
    ).toBe(300_000);
  });

  test("keeps the minute before the first answer and after other errors", () => {
    expect(prStatePollInterval({ ...ok, data: undefined }, NOW)).toBe(60_000);
    expect(
      prStatePollInterval(
        {
          error: rateLimited("Upstream failed"),
          errorUpdatedAt: NOW,
          data: undefined,
        },
        NOW,
      ),
    ).toBe(60_000);
  });

  test("waits out a rate limit even over an open change request", () => {
    expect(
      prStatePollInterval(
        {
          error: rateLimited(
            "GitHub primary rate limit reached; retry in 900s",
          ),
          errorUpdatedAt: NOW,
          data: changeRequest("open"),
        },
        NOW,
      ),
    ).toBe(900_000);
  });

  test("never polls faster than a minute after a short rate limit", () => {
    expect(
      prStatePollInterval(
        {
          error: rateLimited("GitHub primary rate limit reached; retry in 4s"),
          errorUpdatedAt: NOW,
          data: undefined,
        },
        NOW,
      ),
    ).toBe(60_000);
  });
});
