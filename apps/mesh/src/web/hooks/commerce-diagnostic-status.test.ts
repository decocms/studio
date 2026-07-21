import { describe, expect, test } from "bun:test";
import { deriveCommerceReportBannerStatus } from "./commerce-diagnostic-status";

describe("deriveCommerceReportBannerStatus", () => {
  test("no diagnostic hides the banner", () => {
    expect(deriveCommerceReportBannerStatus(null)).toBe("none");
    expect(deriveCommerceReportBannerStatus(undefined)).toBe("none");
  });

  test("a live run is generating, even when a prior deck exists", () => {
    expect(
      deriveCommerceReportBannerStatus({
        run_in_progress: true,
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("generating");
    expect(
      deriveCommerceReportBannerStatus({
        run_in_progress: true,
        scanned_at: null,
      }),
    ).toBe("generating");
  });

  test("a completed run with no live run is ready", () => {
    expect(
      deriveCommerceReportBannerStatus({
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("ready");
    expect(
      deriveCommerceReportBannerStatus({
        run_in_progress: undefined,
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("ready");
  });

  test("claimed but never run (or a stale run the server no longer reports) hides the banner", () => {
    expect(deriveCommerceReportBannerStatus({ scanned_at: null })).toBe("none");
    expect(deriveCommerceReportBannerStatus({})).toBe("none");
  });

  test("run_in_progress: false with a completed scan is ready", () => {
    expect(
      deriveCommerceReportBannerStatus({
        run_in_progress: false,
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("ready");
  });

  test("locked is orthogonal to run status — doesn't affect the derived banner state", () => {
    expect(
      deriveCommerceReportBannerStatus({
        scanned_at: "2026-07-01T00:00:00.000Z",
        locked: true,
      }),
    ).toBe("ready");
    expect(
      deriveCommerceReportBannerStatus({
        run_in_progress: true,
        locked: false,
      }),
    ).toBe("generating");
  });
});
