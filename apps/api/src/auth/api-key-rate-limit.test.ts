import { describe, expect, it } from "bun:test";
import { createApiKeyRateLimiter } from "./api-key-rate-limit";

function setup(
  mode: "observe" | "enforce",
  overrides: { limit?: number; maxEntries?: number } = {},
) {
  let clock = 0;
  const exceeded: string[] = [];
  const limiter = createApiKeyRateLimiter({
    mode,
    limit: overrides.limit ?? 3,
    windowMs: 60_000,
    maxEntries: overrides.maxEntries,
    now: () => clock,
    onExceeded: (keyId) => exceeded.push(keyId),
  });
  return {
    limiter,
    exceeded,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createApiKeyRateLimiter", () => {
  it("allows up to the limit, then answers with the time left in the window", () => {
    const { limiter, advance } = setup("enforce");
    for (let i = 0; i < 3; i++) expect(limiter.hit("k1").allowed).toBe(true);
    advance(20_500);
    expect(limiter.hit("k1")).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it("restarts the window for a key that never goes idle", () => {
    const { limiter, advance } = setup("enforce");
    for (let i = 0; i < 4; i++) {
      limiter.hit("k1");
      advance(15_000);
    }
    expect(limiter.hit("k1").allowed).toBe(true);
  });

  it("counts each key separately", () => {
    const { limiter } = setup("enforce", { limit: 1 });
    expect(limiter.hit("k1").allowed).toBe(true);
    expect(limiter.hit("k2").allowed).toBe(true);
    expect(limiter.hit("k1").allowed).toBe(false);
  });

  it("reports once per window and never blocks in observe mode", () => {
    const { limiter, exceeded, advance } = setup("observe", { limit: 1 });
    for (let i = 0; i < 5; i++) expect(limiter.hit("k1").allowed).toBe(true);
    expect(exceeded).toEqual(["k1"]);
    advance(60_000);
    limiter.hit("k1");
    limiter.hit("k1");
    expect(exceeded).toEqual(["k1", "k1"]);
  });

  it("drops expired windows and caps the number of tracked keys", () => {
    const { limiter, advance } = setup("enforce", { maxEntries: 2 });
    limiter.hit("k1");
    limiter.hit("k2");
    limiter.hit("k3");
    expect(limiter.size()).toBe(2);
    advance(60_000);
    limiter.hit("k4");
    expect(limiter.size()).toBe(1);
  });
});
