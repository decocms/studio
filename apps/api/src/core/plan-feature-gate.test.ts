import { describe, expect, it } from "bun:test";
import { isFeatureAllowed, isUsageBlocked } from "./plan-feature-gate";

describe("isFeatureAllowed", () => {
  it("denies an absent key — absent means denied, not unknown", () => {
    expect(isFeatureAllowed({ cms: true }, "kanban")).toBe(false);
  });

  it("denies an explicit false", () => {
    expect(isFeatureAllowed({ kanban: false }, "kanban")).toBe(false);
  });

  it("allows only an explicit true", () => {
    expect(isFeatureAllowed({ kanban: true }, "kanban")).toBe(true);
  });

  it("FAILS OPEN when the gateway has no answer at all", () => {
    // A gateway outage must not lock every tenant out of its own CMS; the
    // spend is metered by the gateway regardless of what this returns.
    expect(isFeatureAllowed(null, "cms")).toBe(true);
    expect(isFeatureAllowed(null, "model_choice")).toBe(true);
  });

  it("does not treat a truthy non-boolean as granted", () => {
    expect(
      isFeatureAllowed(
        { cms: "yes" } as unknown as Record<string, boolean>,
        "cms",
      ),
    ).toBe(false);
  });
});

describe("isUsageBlocked", () => {
  it("stops an exhausted bar", () => {
    expect(isUsageBlocked("exhausted")).toBe(true);
  });

  it("lets ok and warn through", () => {
    expect(isUsageBlocked("ok")).toBe(false);
    expect(isUsageBlocked("warn")).toBe(false);
  });

  it("treats an unread bar as unknown, never as exhausted", () => {
    // `usage: null` means the gateway could not read consumption. Stopping a
    // paying org's chat on a failed read is the worse bug. It is also what a
    // plans-disabled deployment produces, which is why there is no second
    // enforcement flag to check here.
    expect(isUsageBlocked(null)).toBe(false);
  });
});
