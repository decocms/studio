import { describe, it, expect } from "bun:test";
import { isRunStuck } from "./liveness";

const MIN = 60_000;

describe("isRunStuck (progress-based liveness)", () => {
  it("A1: a 3-hour-old run that made progress 10s ago is NOT stuck", () => {
    const now = 3 * 60 * MIN; // 3h on an arbitrary clock
    expect(
      isRunStuck({ lastProgressAt: now - 10_000, now, idleTimeoutMs: 5 * MIN }),
    ).toBe(false);
  });

  it("A2: a flapping run that resumes but makes no progress eventually trips", () => {
    // 'resume' does not reset anything — only real progress moves lastProgressAt.
    const start = 0;
    const lastProgressAt = start; // no progress since start
    const now = start + 6 * MIN; // 6 min later, idle timeout 5 min
    expect(isRunStuck({ lastProgressAt, now, idleTimeoutMs: 5 * MIN })).toBe(
      true,
    );
  });

  it("is not stuck exactly at the timeout boundary", () => {
    expect(
      isRunStuck({ lastProgressAt: 0, now: 5 * MIN, idleTimeoutMs: 5 * MIN }),
    ).toBe(false);
  });

  it("is stuck just past the boundary", () => {
    expect(
      isRunStuck({
        lastProgressAt: 0,
        now: 5 * MIN + 1,
        idleTimeoutMs: 5 * MIN,
      }),
    ).toBe(true);
  });
});
