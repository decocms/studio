import { describe, expect, test } from "bun:test";
import { shouldResumeThreadInProcess } from "./orphan-recovery";

describe("shouldResumeThreadInProcess", () => {
  test("skips user-desktop runs", () => {
    expect(
      shouldResumeThreadInProcess({ sandbox_provider_kind: "user-desktop" }),
    ).toBe(false);
  });

  test("allows hosted and legacy runs", () => {
    expect(
      shouldResumeThreadInProcess({ sandbox_provider_kind: "agent-sandbox" }),
    ).toBe(true);
    expect(shouldResumeThreadInProcess({ sandbox_provider_kind: null })).toBe(
      true,
    );
  });
});
