import { describe, it, expect } from "bun:test";
import {
  MONITORING_SPAN_NAME,
  DEFAULT_SYSTEM_DIR,
  DEFAULT_LOGS_DIR,
  DEFAULT_TRACES_DIR,
  DEFAULT_METRICS_DIR,
  MONITORING_LOG_ATTR,
  MONITORING_LOG_TYPE_VALUE,
  logRecordToMonitoringRow,
  hrTimeToMs,
  hrTimeToISO,
  type LogRecordInput,
} from "./schema";

describe("monitoring schema", () => {
  it("should define shared constants", () => {
    expect(MONITORING_SPAN_NAME).toBe("mcp.proxy.callTool");
    expect(DEFAULT_SYSTEM_DIR).toContain("deco");
    expect(DEFAULT_SYSTEM_DIR).toContain("system");
    expect(DEFAULT_LOGS_DIR).toContain("logs");
    expect(DEFAULT_TRACES_DIR).toContain("traces");
    expect(DEFAULT_METRICS_DIR).toContain("metrics");
  });
});

describe("logRecordToMonitoringRow", () => {
  function makeLogRecord(
    attrOverrides: Record<string, string | number | boolean | undefined> = {},
  ): LogRecordInput {
    const now = BigInt(Date.now()) * 1_000_000n;
    return {
      id: "log_test_123",
      timestampNano: now,
      attributes: {
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_test",
        [MONITORING_LOG_ATTR.CONNECTION_ID]: "conn_test",
        [MONITORING_LOG_ATTR.CONNECTION_TITLE]: "Test Server",
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TEST_TOOL",
        [MONITORING_LOG_ATTR.INPUT]: '{"key":"value"}',
        [MONITORING_LOG_ATTR.OUTPUT]: '{"result":"ok"}',
        [MONITORING_LOG_ATTR.IS_ERROR]: false,
        [MONITORING_LOG_ATTR.ERROR_MESSAGE]: "",
        [MONITORING_LOG_ATTR.DURATION_MS]: 100,
        [MONITORING_LOG_ATTR.USER_ID]: "user_1",
        [MONITORING_LOG_ATTR.REQUEST_ID]: "req_test",
        [MONITORING_LOG_ATTR.USER_AGENT]: "cursor/1.0",
        [MONITORING_LOG_ATTR.VIRTUAL_MCP_ID]: "vmcp_1",
        [MONITORING_LOG_ATTR.PROPERTIES]: '{"env":"prod"}',
        ...attrOverrides,
      },
    };
  }

  it("should define MONITORING_LOG_ATTR constants", () => {
    expect(MONITORING_LOG_ATTR.TYPE).toBe("mesh.monitoring.type");
    expect(MONITORING_LOG_ATTR.ORGANIZATION_ID).toBe(
      "mesh.monitoring.organization_id",
    );
    expect(MONITORING_LOG_ATTR.TOOL_NAME).toBe("mesh.monitoring.tool_name");
    expect(MONITORING_LOG_TYPE_VALUE).toBe("tool_call");
  });

  it("should populate all fields correctly", () => {
    const record = makeLogRecord();
    const row = logRecordToMonitoringRow(record);

    expect(row.v).toBe(1);
    expect(row.id).toBe("log_test_123");
    expect(row.organization_id).toBe("org_test");
    expect(row.connection_id).toBe("conn_test");
    expect(row.connection_title).toBe("Test Server");
    expect(row.tool_name).toBe("TEST_TOOL");
    expect(row.input).toBe('{"key":"value"}');
    expect(row.output).toBe('{"result":"ok"}');
    expect(row.is_error).toBe(0);
    expect(row.error_message).toBeNull();
    expect(row.duration_ms).toBe(100);
    expect(row.user_id).toBe("user_1");
    expect(row.request_id).toBe("req_test");
    expect(row.user_agent).toBe("cursor/1.0");
    expect(row.virtual_mcp_id).toBe("vmcp_1");
    expect(row.properties).toBe('{"env":"prod"}');
    expect(row.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("should return null for nullable fields when empty string", () => {
    const record = makeLogRecord({
      [MONITORING_LOG_ATTR.ERROR_MESSAGE]: "",
      [MONITORING_LOG_ATTR.USER_ID]: "",
      [MONITORING_LOG_ATTR.USER_AGENT]: "",
      [MONITORING_LOG_ATTR.VIRTUAL_MCP_ID]: "",
      [MONITORING_LOG_ATTR.PROPERTIES]: "",
    });
    const row = logRecordToMonitoringRow(record);

    expect(row.error_message).toBeNull();
    expect(row.user_id).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.virtual_mcp_id).toBeNull();
    expect(row.properties).toBeNull();
  });

  it("should return values for nullable fields when present", () => {
    const record = makeLogRecord({
      [MONITORING_LOG_ATTR.ERROR_MESSAGE]: "Something broke",
      [MONITORING_LOG_ATTR.USER_ID]: "user_42",
      [MONITORING_LOG_ATTR.USER_AGENT]: "vscode/2.0",
      [MONITORING_LOG_ATTR.VIRTUAL_MCP_ID]: "vmcp_99",
      [MONITORING_LOG_ATTR.PROPERTIES]: '{"key":"val"}',
    });
    const row = logRecordToMonitoringRow(record);

    expect(row.error_message).toBe("Something broke");
    expect(row.user_id).toBe("user_42");
    expect(row.user_agent).toBe("vscode/2.0");
    expect(row.virtual_mcp_id).toBe("vmcp_99");
    expect(row.properties).toBe('{"key":"val"}');
  });

  it("should default to empty strings and 0 for missing attributes", () => {
    const record: LogRecordInput = {
      id: "log_empty",
      timestampNano: BigInt(Date.now()) * 1_000_000n,
      attributes: {},
    };
    const row = logRecordToMonitoringRow(record);

    expect(row.id).toBe("log_empty");
    expect(row.organization_id).toBe("");
    expect(row.connection_id).toBe("");
    expect(row.connection_title).toBe("");
    expect(row.tool_name).toBe("");
    expect(row.input).toBe("");
    expect(row.output).toBe("");
    expect(row.is_error).toBe(0);
    expect(row.error_message).toBeNull();
    expect(row.duration_ms).toBe(0);
    expect(row.user_id).toBeNull();
    expect(row.request_id).toBe("");
    expect(row.user_agent).toBeNull();
    expect(row.virtual_mcp_id).toBeNull();
    expect(row.properties).toBeNull();
  });

  it("should convert is_error boolean true to 1", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({ [MONITORING_LOG_ATTR.IS_ERROR]: true }),
    );
    expect(row.is_error).toBe(1);
  });

  it("should convert is_error boolean false to 0", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({ [MONITORING_LOG_ATTR.IS_ERROR]: false }),
    );
    expect(row.is_error).toBe(0);
  });

  it('should convert is_error string "true" to 1', () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({ [MONITORING_LOG_ATTR.IS_ERROR]: "true" }),
    );
    expect(row.is_error).toBe(1);
  });

  it("should convert is_error number 1 to 1", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({ [MONITORING_LOG_ATTR.IS_ERROR]: 1 }),
    );
    expect(row.is_error).toBe(1);
  });

  it("should convert is_error number 0 to 0", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({ [MONITORING_LOG_ATTR.IS_ERROR]: 0 }),
    );
    expect(row.is_error).toBe(0);
  });

  it("should handle duration_ms as string (type coercion)", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({
        [MONITORING_LOG_ATTR.DURATION_MS]: "250" as unknown as number,
      }),
    );
    expect(row.duration_ms).toBe(250);
  });

  it("should handle duration_ms as number", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({ [MONITORING_LOG_ATTR.DURATION_MS]: 500 }),
    );
    expect(row.duration_ms).toBe(500);
  });

  it("should default duration_ms to 0 for non-numeric string", () => {
    const row = logRecordToMonitoringRow(
      makeLogRecord({
        [MONITORING_LOG_ATTR.DURATION_MS]: "not-a-number" as unknown as number,
      }),
    );
    expect(row.duration_ms).toBe(0);
  });

  it("should convert timestamp from nanoseconds correctly", () => {
    const timestampMs = 1709683200000;
    const timestampNano = BigInt(timestampMs) * 1_000_000n;
    const record = makeLogRecord();
    record.timestampNano = timestampNano;

    const row = logRecordToMonitoringRow(record);
    expect(row.timestamp).toBe(new Date(timestampMs).toISOString());
  });

  it("should use the record id as row id", () => {
    const record = makeLogRecord();
    record.id = "custom_id_abc";

    const row = logRecordToMonitoringRow(record);
    expect(row.id).toBe("custom_id_abc");
  });
});

describe("hrTimeToMs", () => {
  it("should convert [0, 0] to 0", () => {
    expect(hrTimeToMs([0, 0])).toBe(0);
  });

  it("should convert seconds and nanoseconds to milliseconds", () => {
    expect(hrTimeToMs([1, 500_000_000])).toBe(1500);
  });

  it("should handle sub-millisecond nanoseconds", () => {
    expect(hrTimeToMs([0, 1_000_000])).toBe(1);
    expect(hrTimeToMs([0, 999_999])).toBeCloseTo(0.999999, 5);
  });

  it("should handle large epoch timestamps", () => {
    // 2024-03-06T00:00:00Z
    expect(hrTimeToMs([1709683200, 0])).toBe(1709683200000);
  });
});

describe("hrTimeToISO", () => {
  it("should return epoch ISO for [0, 0]", () => {
    expect(hrTimeToISO([0, 0])).toBe("1970-01-01T00:00:00.000Z");
  });

  it("should return correct ISO string", () => {
    expect(hrTimeToISO([1709683200, 0])).toBe("2024-03-06T00:00:00.000Z");
  });

  it("should include millisecond precision", () => {
    expect(hrTimeToISO([1709683200, 500_000_000])).toBe(
      "2024-03-06T00:00:00.500Z",
    );
  });
});
