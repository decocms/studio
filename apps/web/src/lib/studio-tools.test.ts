import { afterEach, describe, expect, it } from "bun:test";
import {
  callStudioTool,
  PLAN_REFUSAL_CODES,
  planRefusalOf,
  rateLimitWaitOf,
  StudioToolError,
} from "./studio-tools";

describe("planRefusalOf", () => {
  it("recognises both codes the server actually sends", () => {
    for (const code of Object.values(PLAN_REFUSAL_CODES)) {
      expect(planRefusalOf(new StudioToolError("nope", 403, code))).toBe(code);
    }
  });

  it("is null for a tool error carrying no code — the old shape", () => {
    expect(planRefusalOf(new StudioToolError("boom", 500))).toBeNull();
  });

  it("is null for some other code, so an unrelated 403 is not a paywall", () => {
    expect(
      planRefusalOf(new StudioToolError("nope", 403, "forbidden")),
    ).toBeNull();
  });

  it("is null for anything that is not a StudioToolError", () => {
    for (const other of [
      null,
      undefined,
      "feature_not_in_plan",
      new Error("x"),
    ]) {
      expect(planRefusalOf(other)).toBeNull();
    }
  });
});

describe("callStudioTool on a rate limit", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function refusal(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    globalThis.fetch = (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      })) as unknown as typeof fetch;
    try {
      await callStudioTool("org", "CHANGE_REQUEST_STATE", { branch: "draft" });
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to fail");
  }

  it("carries the wait the body names", async () => {
    const error = await refusal(
      429,
      JSON.stringify({
        error: "GitHub primary rate limit reached; retry in 5s",
        code: "provider_rate_limited",
        retryAfterMs: 4_200,
      }),
      { "retry-after": "5" },
    );
    expect(error).toBeInstanceOf(StudioToolError);
    expect(rateLimitWaitOf(error)).toBe(4_200);
  });

  it("falls back to Retry-After seconds", async () => {
    const error = await refusal(429, JSON.stringify({ error: "slow down" }), {
      "retry-after": "30",
    });
    expect(rateLimitWaitOf(error)).toBe(30_000);
  });

  it("assumes a minute when a 429 names no wait", async () => {
    expect(rateLimitWaitOf(await refusal(429, "not json"))).toBe(60_000);
  });

  it("is not a rate limit on any other status", async () => {
    const error = await refusal(
      500,
      JSON.stringify({ error: "boom", retryAfterMs: 1_000 }),
    );
    expect(rateLimitWaitOf(error)).toBeNull();
    expect((error as StudioToolError).retryAfterMs).toBeUndefined();
  });
});

describe("rateLimitWaitOf", () => {
  it("is null for anything that is not a StudioToolError", () => {
    for (const other of [null, undefined, "429", new Error("429")]) {
      expect(rateLimitWaitOf(other)).toBeNull();
    }
  });
});
