/**
 * Shared test utilities for monitoring tests.
 * Used by ndjson-span-exporter.test.ts, monitoring-clickhouse.test.ts,
 * and pipeline.integration.test.ts.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { MESH_ATTR, type MonitoringRow } from "./schema";

/**
 * Creates a minimal ReadableSpan-like object for testing.
 * Real spans come from the OTel SDK, but we only need the fields
 * that NDJSONSpanExporter reads.
 *
 * Field names match the actual ReadableSpan interface from
 * @opentelemetry/sdk-trace-base@2.5.0:
 * - instrumentationScope (not instrumentationLibrary)
 * - parentSpanContext (not parentSpanId)
 */
export function makeTestMonitoringSpan(
  attrOverrides: Record<string, string | number | boolean> = {},
) {
  return {
    spanContext: () => ({
      traceId: "trace_" + Math.random().toString(36).slice(2),
      spanId: "span_" + Math.random().toString(36).slice(2),
      traceFlags: 1,
    }),
    name: "mcp.proxy.callTool",
    startTime: [Math.floor(Date.now() / 1000), 0] as [number, number],
    endTime: [Math.floor(Date.now() / 1000) + 1, 0] as [number, number],
    attributes: {
      [MESH_ATTR.ORGANIZATION_ID]: "org_test",
      [MESH_ATTR.CONNECTION_ID]: "conn_test",
      [MESH_ATTR.CONNECTION_TITLE]: "Test Server",
      [MESH_ATTR.TOOL_NAME]: "TEST_TOOL",
      [MESH_ATTR.TOOL_INPUT]: '{"key":"value"}',
      [MESH_ATTR.TOOL_OUTPUT]: '{"result":"ok"}',
      [MESH_ATTR.TOOL_IS_ERROR]: false,
      [MESH_ATTR.TOOL_DURATION_MS]: 100,
      [MESH_ATTR.REQUEST_ID]: "req_test",
      ...attrOverrides,
    },
    status: { code: 0 },
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    kind: 0,
    duration: [1, 0] as [number, number],
    events: [],
    links: [],
    ended: true,
    parentSpanContext: undefined,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/**
 * Creates a MonitoringRow for testing ClickHouseMonitoringStorage queries.
 * Shared across Plan 02 and Plan 03 tests.
 */
export function makeTestMonitoringRow(
  overrides: Partial<MonitoringRow> = {},
): MonitoringRow {
  return {
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
 * Shared across Plan 02 and Plan 03 tests.
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
      const parentPath = entry.parentPath ?? entry.path;
      results.push(join(parentPath, entry.name));
    }
  }
  return results;
}
