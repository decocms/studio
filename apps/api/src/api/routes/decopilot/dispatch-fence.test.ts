/**
 * Unit tests for `mintRunFenceToken` — the per-turn fence-token minting used by
 * `prepareRun`. The token keys the fence-scoped JetStream dedup
 * (`Nats-Msg-Id = ${runId}:${fenceToken}:${seq}`), so it MUST be unique per
 * turn even when runId (== threadId) is stable across turns. A reused token
 * would collide two turns' chunks into one projector accumulator.
 */
import { describe, expect, it } from "bun:test";

import { mintRunFenceToken } from "./dispatch-fence";

describe("mintRunFenceToken", () => {
  it("mints a fresh token on every call (same-thread turns never collide)", () => {
    const a = mintRunFenceToken();
    const b = mintRunFenceToken();
    expect(a).not.toBe(b);
  });

  it("mints UUID-shaped tokens", () => {
    const token = mintRunFenceToken();
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("never repeats across many calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(mintRunFenceToken());
    expect(tokens.size).toBe(1000);
  });
});
