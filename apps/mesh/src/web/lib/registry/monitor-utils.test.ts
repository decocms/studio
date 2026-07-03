import { describe, expect, it } from "bun:test";
import {
  collapseLatestToolResults,
  formatMonitorDuration,
  monitorStatusBadgeClass,
} from "./monitor-utils";
import type { MonitorToolResult } from "./types";

describe("monitorStatusBadgeClass", () => {
  it("returns a class for each known status", () => {
    expect(monitorStatusBadgeClass("running")).toContain("blue");
    expect(monitorStatusBadgeClass("completed")).toContain("emerald");
    expect(monitorStatusBadgeClass("failed")).toContain("red");
    expect(monitorStatusBadgeClass("cancelled")).toContain("zinc");
    expect(monitorStatusBadgeClass("pending")).toContain("amber");
  });

  it("returns empty string for an unknown status", () => {
    expect(monitorStatusBadgeClass("bogus")).toBe("");
  });
});

describe("formatMonitorDuration", () => {
  it("returns null when not started", () => {
    expect(formatMonitorDuration(null, null)).toBeNull();
  });

  it("formats sub-second durations in ms", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:00:00.500Z";
    expect(formatMonitorDuration(start, end)).toBe("500ms");
  });

  it("formats durations under a minute in seconds with one decimal", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:00:01.500Z";
    expect(formatMonitorDuration(start, end)).toBe("1.5s");
  });

  it("formats durations over a minute as minutes and seconds", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:01:05.000Z";
    expect(formatMonitorDuration(start, end)).toBe("1m 5s");
  });

  it("treats the 1000ms boundary as seconds, not ms", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:00:01.000Z";
    expect(formatMonitorDuration(start, end)).toBe("1.0s");
  });
});

describe("collapseLatestToolResults", () => {
  const result = (toolName: string, durationMs: number): MonitorToolResult => ({
    toolName,
    success: true,
    durationMs,
  });

  it("keeps only the latest result per tool name", () => {
    const results = [result("a", 1), result("b", 2), result("a", 3)];
    const collapsed = collapseLatestToolResults(results);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((r) => r.toolName === "a")?.durationMs).toBe(3);
  });

  it("moves a repeated tool name to the end, reflecting its latest call order", () => {
    const results = [result("a", 1), result("b", 2), result("a", 3)];
    const collapsed = collapseLatestToolResults(results);
    expect(collapsed.map((r) => r.toolName)).toEqual(["b", "a"]);
  });

  it("returns an empty array for no results", () => {
    expect(collapseLatestToolResults([])).toEqual([]);
  });
});
