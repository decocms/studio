import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_TOKENS,
  resolveMaxOutputTokens,
  selectActiveTools,
} from "./harness-constants";

describe("harness-constants", () => {
  it("exposes the default max tokens", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(32768);
  });
});

describe("selectActiveTools", () => {
  const tools = { a: {}, b: {}, c: {} };

  it("keeps only the named tools", () => {
    expect(Object.keys(selectActiveTools(tools, ["a", "c"]))).toEqual([
      "a",
      "c",
    ]);
  });

  it("passes the full set through when no names are given", () => {
    expect(selectActiveTools(tools, undefined)).toBe(tools);
  });

  it("returns nothing for an empty active list — not everything", () => {
    expect(selectActiveTools(tools, [])).toEqual({});
  });

  it("ignores names with no matching tool", () => {
    expect(Object.keys(selectActiveTools(tools, ["a", "gone"]))).toEqual(["a"]);
  });
});

describe("resolveMaxOutputTokens", () => {
  const haiku = { contextWindow: 200_000, maxOutputTokens: 64_000 };

  it("grants the model's full output budget on a normal prompt", () => {
    expect(resolveMaxOutputTokens(haiku, 52_000)).toBe(64_000);
  });

  it("falls back to the default when the model reports no limits", () => {
    expect(resolveMaxOutputTokens(undefined, 52_000)).toBe(DEFAULT_MAX_TOKENS);
  });

  it("shrinks the budget as the prompt approaches half the window", () => {
    expect(resolveMaxOutputTokens(haiku, 90_000)).toBe(20_000);
  });

  it("floors at 1024 once the estimate exceeds half the window", () => {
    expect(resolveMaxOutputTokens(haiku, 120_000)).toBe(1024);
  });
});

// Regression: thread 0ab7046d ran anthropic/claude-haiku-4.5 (200k window, 64k
// output) with 758 assembled tools but only 23 active. Estimating the full set
// pushed the input estimate past 99,488 — half the window — so all five turns
// came back with exactly 1024 completion tokens and finishReason "length", and
// each "continue" click only made the input longer.
describe("the 758-tool regression", () => {
  const haiku = { contextWindow: 200_000, maxOutputTokens: 64_000 };
  const schema = { x: "y".repeat(400) };
  const tools = Object.fromEntries(
    Array.from({ length: 758 }, (_, i) => [`tool_${i}`, schema]),
  );
  const activeNames = Object.keys(tools).slice(0, 23);
  const estimate = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);
  const prompt = 44_000;

  it("collapses to the 1024 floor when sized off every assembled tool", () => {
    const all = prompt + estimate(selectActiveTools(tools, undefined));
    expect(all).toBeGreaterThan(99_488);
    expect(resolveMaxOutputTokens(haiku, all)).toBe(1024);
  });

  it("keeps the full budget when sized off the active tools only", () => {
    const active = prompt + estimate(selectActiveTools(tools, activeNames));
    expect(active).toBeLessThan(99_488);
    expect(resolveMaxOutputTokens(haiku, active)).toBe(64_000);
  });
});
