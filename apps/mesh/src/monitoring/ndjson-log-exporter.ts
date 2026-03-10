import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  MONITORING_LOG_ATTR,
  MONITORING_LOG_TYPE_VALUE,
  logRecordToMonitoringRow,
  type MonitoringRow,
} from "./schema";
import { NDJSONExporter, type NDJSONExporterOptions } from "./ndjson-exporter";

export type NDJSONLogExporterOptions = NDJSONExporterOptions;

export class NDJSONLogExporter implements LogRecordExporter {
  private inner: NDJSONExporter<MonitoringRow>;

  constructor(options: NDJSONLogExporterOptions) {
    this.inner = new NDJSONExporter<MonitoringRow>(options);
  }

  export(
    logRecords: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const rows: MonitoringRow[] = [];

    for (const record of logRecords) {
      if (
        record.attributes[MONITORING_LOG_ATTR.TYPE] !==
        MONITORING_LOG_TYPE_VALUE
      ) {
        continue;
      }

      const attrs: Record<string, string | number | boolean | undefined> = {};
      for (const [key, value] of Object.entries(record.attributes)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          attrs[key] = value;
        }
      }

      const id = record.spanContext?.spanId ?? crypto.randomUUID();
      const hrTime = record.hrTime;
      const timestampNano =
        BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1]);

      rows.push(
        logRecordToMonitoringRow({ id, timestampNano, attributes: attrs }),
      );
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
