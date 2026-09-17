import { describe, expect, test } from "bun:test";
import {
  deriveReportBannerStatus,
  isReportsDiagnosticLoading,
} from "./reports-diagnostic-status";

describe("deriveReportBannerStatus", () => {
  test("no diagnostic hides the banner", () => {
    expect(deriveReportBannerStatus(null)).toBe("none");
    expect(deriveReportBannerStatus(undefined)).toBe("none");
  });

  test("a live run is generating, even when a prior deck exists", () => {
    expect(
      deriveReportBannerStatus({
        run_in_progress: true,
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("generating");
    expect(
      deriveReportBannerStatus({
        run_in_progress: true,
        scanned_at: null,
      }),
    ).toBe("generating");
  });

  test("a completed run with no live run is ready", () => {
    expect(
      deriveReportBannerStatus({
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("ready");
    expect(
      deriveReportBannerStatus({
        run_in_progress: undefined,
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("ready");
  });

  test("claimed but never run (or a stale run the server no longer reports) hides the banner", () => {
    expect(deriveReportBannerStatus({ scanned_at: null })).toBe("none");
    expect(deriveReportBannerStatus({})).toBe("none");
  });

  test("run_in_progress: false with a completed scan is ready", () => {
    expect(
      deriveReportBannerStatus({
        run_in_progress: false,
        scanned_at: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("ready");
  });

  test("locked is orthogonal to run status — doesn't affect the derived banner state", () => {
    expect(
      deriveReportBannerStatus({
        scanned_at: "2026-07-01T00:00:00.000Z",
        locked: true,
      }),
    ).toBe("ready");
    expect(
      deriveReportBannerStatus({
        run_in_progress: true,
        locked: false,
      }),
    ).toBe("generating");
  });
});

describe("isReportsDiagnosticLoading", () => {
  test("loading while gate 1 (the connection lookup) is in flight", () => {
    expect(
      isReportsDiagnosticLoading({
        connectionQueryPending: true,
        hasConnection: false,
        cdClientFailed: false,
        diagnosticQueryPending: true,
      }),
    ).toBe(true);
  });

  test("not loading once gate 1 resolves with no CD connection", () => {
    expect(
      isReportsDiagnosticLoading({
        connectionQueryPending: false,
        hasConnection: false,
        cdClientFailed: false,
        diagnosticQueryPending: true,
      }),
    ).toBe(false);
  });

  test("loading while the diagnostic read (gate 2) is in flight", () => {
    expect(
      isReportsDiagnosticLoading({
        connectionQueryPending: false,
        hasConnection: true,
        cdClientFailed: false,
        diagnosticQueryPending: true,
      }),
    ).toBe(true);
  });

  test("not loading once the diagnostic read resolves", () => {
    expect(
      isReportsDiagnosticLoading({
        connectionQueryPending: false,
        hasConnection: true,
        cdClientFailed: false,
        diagnosticQueryPending: false,
      }),
    ).toBe(false);
  });

  test("a failed gate-2 client open resolves to not-loading, not stuck forever", () => {
    // regression: a disabled query never leaves "pending" on its own
    expect(
      isReportsDiagnosticLoading({
        connectionQueryPending: false,
        hasConnection: true,
        cdClientFailed: true,
        diagnosticQueryPending: true,
      }),
    ).toBe(false);
  });
});
