import { describe, expect, it } from "bun:test";
import {
  editsBlocksDraft,
  experimentsRouteView,
  experimentsTabVisible,
  pickExperimentsTab,
} from "./experiments-tab-choice";

const pick = (
  flagEnabled: boolean,
  ui: string | undefined,
  siteMajor: "v8" | "v7" | "loading" | "error" = "v7",
) => pickExperimentsTab({ flagEnabled, ui, siteMajor });

describe("pickExperimentsTab", () => {
  it("renders the legacy tab when the org flag is off", () => {
    expect(pick(false, undefined)).toBe("legacy");
  });

  it("renders the rebuilt tab when the org flag is on", () => {
    expect(pick(true, undefined)).toBe("v2");
  });

  it("previews the legacy tab on ?ui=legacy without changing the org", () => {
    expect(pick(true, "legacy")).toBe("legacy");
  });

  it("never moves forward — ?ui= cannot enable the rebuilt tab", () => {
    expect(pick(false, "v2")).toBe("legacy");
    expect(pick(false, "legacy")).toBe("legacy");
  });

  it("ignores an unrecognized ?ui= value", () => {
    expect(pick(true, "nonsense")).toBe("v2");
    expect(pick(true, "")).toBe("v2");
  });

  it("gives a Blocks (v8) site its content tab, whatever the flag or ?ui= says", () => {
    for (const flag of [false, true]) {
      for (const ui of [undefined, "legacy", "v2"]) {
        expect(pick(flag, ui, "v8")).toBe("v8");
      }
    }
  });

  it("opens a site last found v8 as v8 while its main can't be read", () => {
    expect(pick(false, undefined, "error")).toBe("v8");
  });

  it("v8 (last found v8): waits while main's schema is read, so no other tab flashes first", () => {
    for (const flagEnabled of [true, false]) {
      expect(
        pickExperimentsTab({
          flagEnabled,
          ui: undefined,
          siteMajor: "loading",
          lastFoundV8: true,
        }),
      ).toBe("loading");
    }
  });

  it("v7 (never found v8): shows v7's choice at once while main's schema is read, as before", () => {
    expect(pick(true, undefined, "loading")).toBe("v2");
    expect(pick(false, undefined, "loading")).toBe("legacy");
    expect(pick(true, "legacy", "loading")).toBe("legacy");
  });
});

describe("experimentsRouteView", () => {
  const view = (
    orgEnabled: boolean,
    siteMajor: "v8" | "v7" | "loading" | "error",
    lastFoundV8 = false,
  ) => experimentsRouteView({ orgEnabled, siteMajor, lastFoundV8 });

  it("v7: the org's rollout decides at once, loading or not, as before", () => {
    expect(view(true, "v7")).toBe("tab");
    expect(view(false, "v7")).toBe("settings");
    expect(view(true, "loading")).toBe("tab");
    expect(view(false, "loading")).toBe("settings");
  });

  it("v8: the tab whatever the rollout, waiting on a site last found v8", () => {
    expect(view(false, "v8")).toBe("tab");
    expect(view(false, "error", true)).toBe("tab");
    expect(view(false, "loading", true)).toBe("loading");
    expect(view(true, "loading", true)).toBe("tab");
  });
});

describe("experimentsTabVisible", () => {
  it("keeps the org's rollout for v7 sites", () => {
    expect(experimentsTabVisible(false, "v7")).toBe(false);
    expect(experimentsTabVisible(true, "v7")).toBe(true);
    expect(experimentsTabVisible(false, "loading")).toBe(false);
  });

  it("shows the tab on every v8 site", () => {
    expect(experimentsTabVisible(false, "v8")).toBe(true);
    expect(experimentsTabVisible(false, "error")).toBe(true);
  });
});

describe("editsBlocksDraft", () => {
  it("is every Blocks (v8) site, including one last found v8", () => {
    expect(editsBlocksDraft("v8")).toBe(true);
    expect(editsBlocksDraft("error")).toBe(true);
  });

  it("is no other site, and waits while main's schema is read", () => {
    expect(editsBlocksDraft("v7")).toBe(false);
    expect(editsBlocksDraft("loading")).toBe(false);
  });
});
