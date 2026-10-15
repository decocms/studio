import { describe, expect, it } from "bun:test";
import { pickExperimentsTab } from "./experiments-tab-choice";

describe("pickExperimentsTab", () => {
  it("renders the legacy tab when the org flag is off", () => {
    expect(pickExperimentsTab(false, undefined)).toBe("legacy");
  });

  it("renders the rebuilt tab when the org flag is on", () => {
    expect(pickExperimentsTab(true, undefined)).toBe("v2");
  });

  it("previews the legacy tab on ?ui=legacy without changing the org", () => {
    expect(pickExperimentsTab(true, "legacy")).toBe("legacy");
  });

  it("never moves forward — ?ui= cannot enable the rebuilt tab", () => {
    expect(pickExperimentsTab(false, "v2")).toBe("legacy");
    expect(pickExperimentsTab(false, "legacy")).toBe("legacy");
  });

  it("ignores an unrecognized ?ui= value", () => {
    expect(pickExperimentsTab(true, "nonsense")).toBe("v2");
    expect(pickExperimentsTab(true, "")).toBe("v2");
  });
});
