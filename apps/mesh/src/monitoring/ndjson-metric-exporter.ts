import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality,
  DataPointType,
  type InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { type MetricRow, hrTimeToISO } from "./schema";
import { NDJSONExporter, type NDJSONExporterOptions } from "./ndjson-exporter";

export type NDJSONMetricExporterOptions = NDJSONExporterOptions;

export class NDJSONMetricExporter implements PushMetricExporter {
  private inner: NDJSONExporter<MetricRow>;

  constructor(options: NDJSONMetricExporterOptions) {
    this.inner = new NDJSONExporter<MetricRow>(options);
  }

  selectAggregationTemporality(
    _instrumentType: InstrumentType,
  ): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const rows: MetricRow[] = [];

    for (const scopeMetrics of metrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const { descriptor, dataPointType } = metric;

        if (dataPointType === DataPointType.SUM) {
          for (const dp of metric.dataPoints) {
            const attrs = dp.attributes;
            rows.push({
              v: 1,
              name: descriptor.name,
              type: "sum",
              unit: descriptor.unit,
              timestamp: hrTimeToISO(dp.endTime),
              organization_id: String(attrs["organization.id"] ?? ""),
              connection_id: String(attrs["connection.id"] ?? ""),
              tool_name: String(attrs["tool.name"] ?? ""),
              status: String(attrs["status"] ?? ""),
              error_type: String(attrs["error.type"] ?? ""),
              value: dp.value as number,
              hist_count: 0,
              hist_sum: 0,
              hist_min: 0,
              hist_max: 0,
              hist_boundaries: "[]",
              hist_bucket_counts: "[]",
            });
          }
        } else if (dataPointType === DataPointType.HISTOGRAM) {
          for (const dp of metric.dataPoints) {
            const attrs = dp.attributes;
            const hist = dp.value as {
              count: number;
              sum?: number;
              min?: number;
              max?: number;
              buckets: { boundaries: number[]; counts: number[] };
            };
            rows.push({
              v: 1,
              name: descriptor.name,
              type: "histogram",
              unit: descriptor.unit,
              timestamp: hrTimeToISO(dp.endTime),
              organization_id: String(attrs["organization.id"] ?? ""),
              connection_id: String(attrs["connection.id"] ?? ""),
              tool_name: String(attrs["tool.name"] ?? ""),
              status: String(attrs["status"] ?? ""),
              error_type: String(attrs["error.type"] ?? ""),
              value: hist.count,
              hist_count: hist.count,
              hist_sum: hist.sum ?? 0,
              hist_min: hist.min ?? 0,
              hist_max: hist.max ?? 0,
              hist_boundaries: JSON.stringify(hist.buckets.boundaries),
              hist_bucket_counts: JSON.stringify(hist.buckets.counts),
            });
          }
        }
      }
    }

    this.inner
      .exportRows(rows)
      .then((result) => resultCallback(result))
      .catch(() => resultCallback({ code: ExportResultCode.FAILED }));
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush();
  }
}
