import { describe, expect, it } from "bun:test";
import { deriveDiagnosticBannerState } from "./diagnostic-banner-state";

describe("deriveDiagnosticBannerState", () => {
  it("hides when the org has no diagnostic", () => {
    expect(
      deriveDiagnosticBannerState({ status: "none", reportTaskCount: 0 }),
    ).toEqual({ kind: "hidden", taskCount: 0 });
  });

  it("announces a live run before anything is imported", () => {
    expect(
      deriveDiagnosticBannerState({ status: "generating", reportTaskCount: 0 }),
    ).toEqual({ kind: "generating", taskCount: 0 });
  });

  it("keeps announcing the run even while locked", () => {
    expect(
      deriveDiagnosticBannerState({
        status: "generating",
        locked: true,
        reportTaskCount: 0,
      }).kind,
    ).toBe("generating");
  });

  it("asks for the unlock when a ready deck is still paywalled", () => {
    expect(
      deriveDiagnosticBannerState({
        status: "ready",
        locked: true,
        reportTaskCount: 0,
      }).kind,
    ).toBe("locked");
  });

  it("counts the imported findings once the deck is unlocked", () => {
    expect(
      deriveDiagnosticBannerState({
        status: "ready",
        locked: false,
        reportTaskCount: 7,
      }),
    ).toEqual({ kind: "ready", taskCount: 7 });
  });

  it("still points at the report when nothing has been imported yet", () => {
    expect(
      deriveDiagnosticBannerState({ status: "ready", reportTaskCount: 0 }),
    ).toEqual({ kind: "ready", taskCount: 0 });
  });

  it("floors a nonsense count at zero", () => {
    expect(
      deriveDiagnosticBannerState({ status: "ready", reportTaskCount: -3 })
        .taskCount,
    ).toBe(0);
  });
});
