import { describe, expect, it } from "bun:test";
import {
  experimentsRouteView,
  experimentsTabVisible,
  pickExperimentsTab,
} from "./experiments-tab-choice";

const pick = (flagEnabled: boolean, ui: string | undefined, v8 = false) =>
  pickExperimentsTab({ flagEnabled, ui, v8 });

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

  it("gives a Blocks v8 project its content tab, whatever the flag or ?ui= says", () => {
    for (const flag of [false, true]) {
      for (const ui of [undefined, "legacy", "v2"]) {
        expect(pick(flag, ui, true)).toBe("v8");
      }
    }
  });
});

describe("experimentsTabVisible", () => {
  it("keeps the org's rollout with the switch off (v7)", () => {
    expect(experimentsTabVisible(false, false)).toBe(false);
    expect(experimentsTabVisible(true, false)).toBe(true);
  });

  it("shows the tab on every v8 project", () => {
    expect(experimentsTabVisible(false, true)).toBe(true);
  });
});

describe("experimentsRouteView", () => {
  it("gives a Blocks v8 project its Experiments app", () => {
    expect(experimentsRouteView(true)).toBe("app");
  });

  it("sends any other project to Monitor's Experiments view", () => {
    expect(experimentsRouteView(false)).toBe("monitor");
  });
});
