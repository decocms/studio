import { describe, expect, it } from "bun:test";
import { ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { NDJSONMetricExporter } from "./ndjson-metric-exporter";

/** Helper: build a minimal ResourceMetrics with the given metric entries. */
function buildResourceMetrics(
  metrics: ResourceMetrics["scopeMetrics"][number]["metrics"],
): ResourceMetrics {
  return {
    resource: { attributes: {} } as ResourceMetrics["resource"],
    scopeMetrics: [
      {
        scope: { name: "test" },
        metrics,
      },
    ],
  };
}

/** Fixed hrTime for deterministic timestamps. */
const HR_TIME: [number, number] = [1700000000, 0];
const EXPECTED_TIMESTAMP = new Date(1700000000 * 1000).toISOString();

describe("NDJSONMetricExporter", () => {
  it("selectAggregationTemporality returns DELTA", () => {
    const exporter = new NDJSONMetricExporter({
      basePath: "/tmp/test-metrics",
    });
    // InstrumentType doesn't matter — always DELTA
    expect(exporter.selectAggregationTemporality(0 as never)).toBe(
      AggregationTemporality.DELTA,
    );
  });

  it("exports counter (Sum) data points correctly", async () => {
    const exportedRows: unknown[] = [];
    const exporter = new NDJSONMetricExporter({
      basePath: "/tmp/test-metrics",
    });

    // Monkey-patch inner exporter to capture rows
    (
      exporter as unknown as {
        inner: { exportRows: (rows: unknown[]) => Promise<{ code: number }> };
      }
    ).inner.exportRows = async (rows) => {
      exportedRows.push(...rows);
      return { code: ExportResultCode.SUCCESS };
    };

    const metrics = buildResourceMetrics([
      {
        descriptor: {
          name: "tool.call.count",
          description: "",
          unit: "1",
          valueType: 1,
        },
        aggregationTemporality: AggregationTemporality.DELTA,
        dataPointType: DataPointType.SUM,
        dataPoints: [
          {
            startTime: HR_TIME,
            endTime: HR_TIME,
            attributes: {
              "organization.id": "org-123",
              "tool.name": "my_tool",
              status: "ok",
              "error.type": "",
            },
            value: 42,
          },
        ],
        isMonotonic: true,
      },
    ]);

    await new Promise<void>((resolve) => {
      exporter.export(metrics, (result) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        resolve();
      });
    });

    expect(exportedRows).toHaveLength(1);
    const row = exportedRows[0] as Record<string, unknown>;
    expect(row).toEqual({
      v: 1,
      name: "tool.call.count",
      type: "sum",
      unit: "1",
      timestamp: EXPECTED_TIMESTAMP,
      organization_id: "org-123",
      tool_name: "my_tool",
      status: "ok",
      error_type: "",
      value: 42,
      hist_count: 0,
      hist_sum: 0,
      hist_min: 0,
      hist_max: 0,
      hist_boundaries: "[]",
      hist_bucket_counts: "[]",
    });
  });

  it("exports histogram data points with boundaries and counts", async () => {
    const exportedRows: unknown[] = [];
    const exporter = new NDJSONMetricExporter({
      basePath: "/tmp/test-metrics",
    });

    (
      exporter as unknown as {
        inner: { exportRows: (rows: unknown[]) => Promise<{ code: number }> };
      }
    ).inner.exportRows = async (rows) => {
      exportedRows.push(...rows);
      return { code: ExportResultCode.SUCCESS };
    };

    const metrics = buildResourceMetrics([
      {
        descriptor: {
          name: "tool.call.duration",
          description: "",
          unit: "ms",
          valueType: 1,
        },
        aggregationTemporality: AggregationTemporality.DELTA,
        dataPointType: DataPointType.HISTOGRAM,
        dataPoints: [
          {
            startTime: HR_TIME,
            endTime: HR_TIME,
            attributes: {
              "organization.id": "org-456",
              "tool.name": "slow_tool",
              status: "error",
              "error.type": "timeout",
            },
            value: {
              count: 10,
              sum: 5000,
              min: 100,
              max: 2000,
              buckets: {
                boundaries: [50, 100, 250, 500, 1000],
                counts: [0, 1, 3, 4, 1, 1],
              },
            },
          },
        ],
      },
    ]);

    await new Promise<void>((resolve) => {
      exporter.export(metrics, (result) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        resolve();
      });
    });

    expect(exportedRows).toHaveLength(1);
    const row = exportedRows[0] as Record<string, unknown>;
    expect(row).toEqual({
      v: 1,
      name: "tool.call.duration",
      type: "histogram",
      unit: "ms",
      timestamp: EXPECTED_TIMESTAMP,
      organization_id: "org-456",
      tool_name: "slow_tool",
      status: "error",
      error_type: "timeout",
      value: 10,
      hist_count: 10,
      hist_sum: 5000,
      hist_min: 100,
      hist_max: 2000,
      hist_boundaries: "[50,100,250,500,1000]",
      hist_bucket_counts: "[0,1,3,4,1,1]",
    });
  });

  it("handles empty histogram (count=0)", async () => {
    const exportedRows: unknown[] = [];
    const exporter = new NDJSONMetricExporter({
      basePath: "/tmp/test-metrics",
    });

    (
      exporter as unknown as {
        inner: { exportRows: (rows: unknown[]) => Promise<{ code: number }> };
      }
    ).inner.exportRows = async (rows) => {
      exportedRows.push(...rows);
      return { code: ExportResultCode.SUCCESS };
    };

    const metrics = buildResourceMetrics([
      {
        descriptor: {
          name: "tool.call.duration",
          description: "",
          unit: "ms",
          valueType: 1,
        },
        aggregationTemporality: AggregationTemporality.DELTA,
        dataPointType: DataPointType.HISTOGRAM,
        dataPoints: [
          {
            startTime: HR_TIME,
            endTime: HR_TIME,
            attributes: {
              "organization.id": "org-789",
              "tool.name": "idle_tool",
              status: "ok",
              "error.type": "",
            },
            value: {
              count: 0,
              sum: 0,
              min: 0,
              max: 0,
              buckets: {
                boundaries: [10, 50, 100],
                counts: [0, 0, 0, 0],
              },
            },
          },
        ],
      },
    ]);

    await new Promise<void>((resolve) => {
      exporter.export(metrics, (result) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        resolve();
      });
    });

    expect(exportedRows).toHaveLength(1);
    const row = exportedRows[0] as Record<string, unknown>;
    expect(row.value).toBe(0);
    expect(row.hist_count).toBe(0);
    expect(row.hist_sum).toBe(0);
    expect(row.hist_min).toBe(0);
    expect(row.hist_max).toBe(0);
  });

  it("defaults undefined histogram min/max/sum to 0", async () => {
    const exportedRows: unknown[] = [];
    const exporter = new NDJSONMetricExporter({
      basePath: "/tmp/test-metrics",
    });

    (
      exporter as unknown as {
        inner: { exportRows: (rows: unknown[]) => Promise<{ code: number }> };
      }
    ).inner.exportRows = async (rows) => {
      exportedRows.push(...rows);
      return { code: ExportResultCode.SUCCESS };
    };

    const metrics = buildResourceMetrics([
      {
        descriptor: {
          name: "tool.call.duration",
          description: "",
          unit: "ms",
          valueType: 1,
        },
        aggregationTemporality: AggregationTemporality.DELTA,
        dataPointType: DataPointType.HISTOGRAM,
        dataPoints: [
          {
            startTime: HR_TIME,
            endTime: HR_TIME,
            attributes: {
              "organization.id": "org-abc",
              "tool.name": "test_tool",
              status: "ok",
              "error.type": "",
            },
            value: {
              count: 5,
              // sum, min, max intentionally omitted (undefined)
              buckets: {
                boundaries: [100],
                counts: [3, 2],
              },
            },
          },
        ],
      },
    ]);

    await new Promise<void>((resolve) => {
      exporter.export(metrics, (result) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        resolve();
      });
    });

    expect(exportedRows).toHaveLength(1);
    const row = exportedRows[0] as Record<string, unknown>;
    expect(row.hist_count).toBe(5);
    expect(row.hist_sum).toBe(0);
    expect(row.hist_min).toBe(0);
    expect(row.hist_max).toBe(0);
    expect(row.value).toBe(5);
  });
});
