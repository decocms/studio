/**
 * Shared test utilities for monitoring tests.
 * Used by ndjson-log-exporter.test.ts, monitoring-sql.test.ts,
 * and pipeline.integration.test.ts.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  MONITORING_LOG_ATTR,
  MONITORING_LOG_TYPE_VALUE,
  type MonitoringRow,
} from "./schema";

/**
 * Creates a MonitoringRow for testing SqlMonitoringStorage queries.
 */
export function makeTestMonitoringRow(
  overrides: Partial<MonitoringRow> = {},
): MonitoringRow {
  return {
    v: 1,
    id: `log_${Math.random().toString(36).slice(2)}`,
    organization_id: "org_test",
    connection_id: "conn_1",
    connection_title: "Test Server",
    tool_name: "EXAMPLE_TOOL",
    input: '{"query": "hello"}',
    output: '{"tokens": 100}',
    is_error: 0,
    error_message: null,
    duration_ms: 150,
    timestamp: "2026-03-05T12:00:00.000Z",
    user_id: "user_1",
    request_id: "req_1",
    user_agent: "cursor/1.0",
    virtual_mcp_id: null,
    properties: null,
    ...overrides,
  };
}

/**
 * Writes MonitoringRow objects to an NDJSON file in the given directory.
 */
export async function writeTestNDJSON(
  dir: string,
  rows: MonitoringRow[],
): Promise<void> {
  const content = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(dir, `test-${crypto.randomUUID()}.ndjson`), content, {
    mode: 0o600,
  });
}

/**
 * Creates a minimal ReadableLogRecord-like object for testing.
 * Used by NDJSONLogExporter tests and pipeline integration tests.
 *
 * Mimics the OTel ReadableLogRecord interface with only the fields
 * that NDJSONLogExporter reads.
 */
export function makeTestMonitoringLogRecord(
  attrOverrides: Record<string, string | number | boolean> = {},
) {
  const nowMs = Date.now();
  return {
    hrTime: [Math.floor(nowMs / 1000), (nowMs % 1000) * 1_000_000] as [
      number,
      number,
    ],
    spanContext: undefined,
    attributes: {
      [MONITORING_LOG_ATTR.TYPE]: MONITORING_LOG_TYPE_VALUE,
      [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_test",
      [MONITORING_LOG_ATTR.CONNECTION_ID]: "conn_test",
      [MONITORING_LOG_ATTR.CONNECTION_TITLE]: "Test Server",
      [MONITORING_LOG_ATTR.TOOL_NAME]: "TEST_TOOL",
      [MONITORING_LOG_ATTR.INPUT]: '{"key":"value"}',
      [MONITORING_LOG_ATTR.OUTPUT]: '{"result":"ok"}',
      [MONITORING_LOG_ATTR.IS_ERROR]: false,
      [MONITORING_LOG_ATTR.DURATION_MS]: 100,
      [MONITORING_LOG_ATTR.REQUEST_ID]: "req_test",
      ...attrOverrides,
    },
    severityNumber: 9, // INFO
    severityText: "INFO",
    body: attrOverrides[MONITORING_LOG_ATTR.TOOL_NAME] ?? "TEST_TOOL",
  };
}

/**
 * Recursively find all .ndjson files under a directory.
 * Throws on unexpected errors (permission denied, etc.) instead of swallowing them.
 */
export async function findNDJSONFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err: unknown) {
    // Only swallow ENOENT (dir doesn't exist yet), rethrow others
    if (
      err instanceof Error &&
      "code" in err &&
      (err as any).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".ndjson")) {
      const parentPath = entry.parentPath ?? (entry as any).path;
      results.push(join(parentPath, entry.name));
    }
  }
  return results;
}
