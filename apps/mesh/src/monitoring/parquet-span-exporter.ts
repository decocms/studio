import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DuckDBProvider } from "./duckdb-provider";
import { getBatchFilePath } from "./parquet-paths";
import {
  MONITORING_SPAN_ATTRIBUTES,
  MONITORING_SPAN_NAME,
  CREATE_STAGING_TABLE_SQL,
} from "./parquet-schema";

export interface ParquetSpanExporterOptions {
  /** Base path for Parquet files. Default: ./data/monitoring */
  basePath: string;
  /** Number of spans to buffer before flushing. Default: 1000 */
  flushThreshold?: number;
  /** Milliseconds between periodic flushes. Default: 60000 (1 minute) */
  flushIntervalMs?: number;
}

interface MonitoringRow {
  id: string;
  organization_id: string;
  connection_id: string;
  connection_title: string;
  tool_name: string;
  input: string | null;
  output: string | null;
  is_error: boolean;
  error_message: string | null;
  duration_ms: number;
  timestamp: Date;
  user_id: string | null;
  request_id: string;
  user_agent: string | null;
  virtual_mcp_id: string | null;
  properties: string | null;
}

/**
 * Custom OpenTelemetry SpanExporter that writes monitoring spans
 * to time-partitioned Parquet files via DuckDB.
 *
 * Only processes spans named "mesh.monitoring.tool_call" that have
 * been enriched with mesh.monitoring.* attributes by MonitoringTransport.
 * All other spans are silently ignored (they go to the standard OTLP exporter).
 */
export class ParquetSpanExporter implements SpanExporter {
  private buffer: MonitoringRow[] = [];
  private batchCounter = 0;
  private flushThreshold: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private basePath: string;
  private duckdb: DuckDBProvider;
  private initialized = false;
  private flushLock: Promise<void> = Promise.resolve();

  constructor(options: ParquetSpanExporterOptions) {
    this.basePath = options.basePath;
    this.flushThreshold = options.flushThreshold ?? 1000;
    this.duckdb = new DuckDBProvider(":memory:");

    const intervalMs = options.flushIntervalMs ?? 60_000;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error("[ParquetSpanExporter] Periodic flush failed:", err);
      });
    }, intervalMs);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.duckdb.run(CREATE_STAGING_TABLE_SQL);
    this.initialized = true;
  }

  /**
   * Export spans. Filters for monitoring spans, buffers them,
   * and triggers a flush if the buffer exceeds the threshold.
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const rows = this.extractMonitoringRows(spans);
    this.buffer.push(...rows);

    if (this.buffer.length >= this.flushThreshold) {
      this.flush()
        .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
        .catch((err) => {
          console.error("[ParquetSpanExporter] Flush failed:", err);
          resultCallback({ code: ExportResultCode.FAILED, error: err });
        });
    } else {
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  /**
   * Force flush all buffered spans to Parquet.
   */
  async forceFlush(): Promise<void> {
    await this.flush();
  }

  /**
   * Shutdown: flush remaining spans, stop timer, close DuckDB.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.forceFlush();
    await this.duckdb.close();
  }

  /**
   * Flush buffered rows to a Parquet file.
   * Uses a mutex (flushLock) to prevent concurrent flush operations
   * from corrupting the staging table.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Take the current buffer and reset atomically
    const rows = this.buffer;
    this.buffer = [];

    // Chain onto the flush lock to serialize concurrent flushes
    this.flushLock = this.flushLock
      .then(() => this.doFlush(rows))
      .catch((err) => {
        console.error("[ParquetSpanExporter] Flush failed:", err);
      });

    await this.flushLock;
  }

  private async doFlush(rows: MonitoringRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.ensureInitialized();

    // Bulk INSERT using a single multi-row VALUES clause
    const placeholderRow = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const placeholders = rows.map(() => placeholderRow).join(", ");
    const params: unknown[] = [];
    for (const row of rows) {
      params.push(
        row.id,
        row.organization_id,
        row.connection_id,
        row.connection_title,
        row.tool_name,
        row.input,
        row.output,
        row.is_error,
        row.error_message,
        row.duration_ms,
        row.timestamp.toISOString(),
        row.user_id,
        row.request_id,
        row.user_agent,
        row.virtual_mcp_id,
        row.properties,
      );
    }
    await this.duckdb.run(
      `INSERT INTO monitoring_staging VALUES ${placeholders}`,
      ...params,
    );

    // Determine output file path
    const now = new Date();
    this.batchCounter++;
    const filePath = getBatchFilePath(this.basePath, now, this.batchCounter);

    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });

    // COPY staging table to Parquet file
    await this.duckdb.run(
      `COPY monitoring_staging TO '${filePath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    // Clear staging table for next batch
    await this.duckdb.run("DELETE FROM monitoring_staging");
  }

  /**
   * Extract monitoring rows from spans.
   * Only spans named MONITORING_SPAN_NAME with the required attributes are included.
   */
  private extractMonitoringRows(spans: ReadableSpan[]): MonitoringRow[] {
    const rows: MonitoringRow[] = [];

    for (const span of spans) {
      if (span.name !== MONITORING_SPAN_NAME) continue;

      const attrs = span.attributes;
      const orgId = attrs[MONITORING_SPAN_ATTRIBUTES.ORGANIZATION_ID];
      if (!orgId) continue; // Skip spans without org ID

      rows.push({
        id: span.spanContext().spanId,
        organization_id: String(orgId),
        connection_id: String(
          attrs[MONITORING_SPAN_ATTRIBUTES.CONNECTION_ID] ?? "",
        ),
        connection_title: String(
          attrs[MONITORING_SPAN_ATTRIBUTES.CONNECTION_TITLE] ?? "",
        ),
        tool_name: String(attrs[MONITORING_SPAN_ATTRIBUTES.TOOL_NAME] ?? ""),
        input:
          attrs[MONITORING_SPAN_ATTRIBUTES.INPUT] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.INPUT])
            : null,
        output:
          attrs[MONITORING_SPAN_ATTRIBUTES.OUTPUT] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.OUTPUT])
            : null,
        is_error: Boolean(attrs[MONITORING_SPAN_ATTRIBUTES.IS_ERROR]),
        error_message:
          attrs[MONITORING_SPAN_ATTRIBUTES.ERROR_MESSAGE] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.ERROR_MESSAGE])
            : null,
        duration_ms: Number(attrs[MONITORING_SPAN_ATTRIBUTES.DURATION_MS] ?? 0),
        timestamp: new Date(
          span.startTime[0] * 1000 + span.startTime[1] / 1_000_000,
        ),
        user_id:
          attrs[MONITORING_SPAN_ATTRIBUTES.USER_ID] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.USER_ID])
            : null,
        request_id: String(attrs[MONITORING_SPAN_ATTRIBUTES.REQUEST_ID] ?? ""),
        user_agent:
          attrs[MONITORING_SPAN_ATTRIBUTES.USER_AGENT] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.USER_AGENT])
            : null,
        virtual_mcp_id:
          attrs[MONITORING_SPAN_ATTRIBUTES.VIRTUAL_MCP_ID] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.VIRTUAL_MCP_ID])
            : null,
        properties:
          attrs[MONITORING_SPAN_ATTRIBUTES.PROPERTIES] != null
            ? String(attrs[MONITORING_SPAN_ATTRIBUTES.PROPERTIES])
            : null,
      });
    }

    return rows;
  }
}
