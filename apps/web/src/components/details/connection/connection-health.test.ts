import { describe, expect, it } from "bun:test";
import { computeTopErrors } from "./connection-health";
import type { MonitoringLog } from "@/components/monitoring/monitoring-stats-row.tsx";

const log = (over: Partial<MonitoringLog>): MonitoringLog => ({
  id: "1",
  connectionId: "c",
  toolName: "t",
  isError: false,
  errorMessage: null,
  durationMs: 0,
  timestamp: "",
  ...over,
});

describe("computeTopErrors", () => {
  it("ranks error messages by frequency, ignoring successes", () => {
    const top = computeTopErrors([
      log({ isError: true, errorMessage: "repo not found" }),
      log({ isError: true, errorMessage: "repo not found" }),
      log({ isError: true, errorMessage: "403 forbidden" }),
      log({ isError: false, errorMessage: null }),
    ]);
    expect(top).toEqual([
      { message: "repo not found", count: 2 },
      { message: "403 forbidden", count: 1 },
    ]);
  });

  it("buckets empty/null messages as 'Unknown error'", () => {
    const top = computeTopErrors([
      log({ isError: true, errorMessage: null }),
      log({ isError: true, errorMessage: "  " }),
    ]);
    expect(top).toEqual([{ message: "Unknown error", count: 2 }]);
  });

  it("caps at the requested limit", () => {
    const logs = ["a", "b", "c", "d"].map((m) =>
      log({ isError: true, errorMessage: m }),
    );
    expect(computeTopErrors(logs, 2)).toHaveLength(2);
  });

  it("returns nothing when there are no errors", () => {
    expect(computeTopErrors([log({ isError: false })])).toEqual([]);
  });
});
