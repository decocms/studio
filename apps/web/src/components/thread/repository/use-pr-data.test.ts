import { describe, expect, test } from "bun:test";

import { StudioToolError } from "@/lib/studio-tools";
import { prStatePollInterval, rateLimitCooldownMs } from "./use-pr-data.ts";

const NOW = 1_000_000;

const rateLimited = (retryAfterMs: number) =>
  new StudioToolError(
    "rate limited",
    429,
    "provider_rate_limited",
    retryAfterMs,
  );
const failed = new StudioToolError("Upstream failed", 500);

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

describe("rateLimitCooldownMs", () => {
  test("counts down from when the refusal landed", () => {
    const state = {
      error: rateLimited(120_000),
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
          error: failed,
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
          error: rateLimited(900_000),
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
          error: rateLimited(4_000),
          errorUpdatedAt: NOW,
          data: undefined,
        },
        NOW,
      ),
    ).toBe(60_000);
  });
});
