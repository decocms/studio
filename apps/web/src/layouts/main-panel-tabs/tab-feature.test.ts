import { describe, expect, it } from "bun:test";
import { featureForTab } from "./tab-feature";

describe("featureForTab", () => {
  it("gates the three plan-gated views", () => {
    expect(featureForTab("board")).toBe("kanban");
    expect(featureForTab("cdn")).toBe("monitoring");
    expect(featureForTab("site-editor")).toBe("cms");
  });

  it("gates EVERY view of the Site Editor surface, not just Preview", () => {
    expect(featureForTab("content")).toBe("cms");
    expect(featureForTab("code")).toBe("cms");
    expect(featureForTab("code:src/app.tsx")).toBe("cms");
  });

  it("leaves the ungated views alone", () => {
    for (const tab of ["overview", "files", "reports", "git", "automations"]) {
      expect(featureForTab(tab)).toBeNull();
    }
  });
});
