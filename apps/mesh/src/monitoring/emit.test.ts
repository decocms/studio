import { describe, it, expect, beforeEach } from "bun:test";
import type {
  Logger,
  LoggerProvider,
  LogRecord,
} from "@opentelemetry/api-logs";
import { MONITORING_LOG_ATTR, MONITORING_LOG_TYPE_VALUE } from "./schema";
import { emitMonitoringLog } from "./emit";
import type { EmitMonitoringLogParams } from "./emit";
import { setMonitoringLoggerProvider } from "./logger";

// Capture emitted records by wiring a fake monitoring LoggerProvider through
// the real accessor (setMonitoringLoggerProvider) that initObservability uses.
let emittedRecords: LogRecord[] = [];

const captureLogger: Logger = {
  emit(record: LogRecord) {
    emittedRecords.push(record);
  },
};

setMonitoringLoggerProvider({
  getLogger: () => captureLogger,
} as unknown as LoggerProvider);

function makeParams(
  overrides: Partial<EmitMonitoringLogParams> = {},
): EmitMonitoringLogParams {
  return {
    organizationId: "org_123",
    connectionId: "conn_456",
    toolName: "EXAMPLE_TOOL",
    toolArguments: { query: "test" },
    result: { content: [{ type: "text", text: "ok" }] },
    duration: 150,
    isError: false,
    errorMessage: null,
    userId: "user_789",
    requestId: "req_abc",
    userAgent: "cursor/1.0",
    virtualMcpId: "vmcp_def",
    properties: { env: "prod" },
    ...overrides,
  };
}

describe("emitMonitoringLog", () => {
  beforeEach(() => {
    emittedRecords = [];
  });

  it("should emit a log record with correct monitoring attributes", () => {
    emitMonitoringLog(makeParams());

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;

    expect(attrs[MONITORING_LOG_ATTR.TYPE]).toBe(MONITORING_LOG_TYPE_VALUE);
    expect(attrs[MONITORING_LOG_ATTR.ORGANIZATION_ID]).toBe("org_123");
    expect(attrs[MONITORING_LOG_ATTR.CONNECTION_ID]).toBe("conn_456");
    expect(attrs[MONITORING_LOG_ATTR.CONNECTION_TITLE]).toBe("");
    expect(attrs[MONITORING_LOG_ATTR.TOOL_NAME]).toBe("EXAMPLE_TOOL");
    expect(attrs[MONITORING_LOG_ATTR.IS_ERROR]).toBe(false);
    expect(attrs[MONITORING_LOG_ATTR.DURATION_MS]).toBe(150);
    expect(attrs[MONITORING_LOG_ATTR.USER_ID]).toBe("user_789");
    expect(attrs[MONITORING_LOG_ATTR.REQUEST_ID]).toBe("req_abc");
    expect(attrs[MONITORING_LOG_ATTR.USER_AGENT]).toBe("cursor/1.0");
    expect(attrs[MONITORING_LOG_ATTR.VIRTUAL_MCP_ID]).toBe("vmcp_def");
  });

  it("should not emit when organizationId is empty", () => {
    emitMonitoringLog(makeParams({ organizationId: "" }));
    expect(emittedRecords.length).toBe(0);
  });

  it("should handle null optional fields with empty string fallbacks", () => {
    emitMonitoringLog(
      makeParams({
        userId: null,
        userAgent: null,
        virtualMcpId: null,
        properties: null,
      }),
    );

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    expect(attrs[MONITORING_LOG_ATTR.USER_ID]).toBe("");
    expect(attrs[MONITORING_LOG_ATTR.USER_AGENT]).toBe("");
    expect(attrs[MONITORING_LOG_ATTR.VIRTUAL_MCP_ID]).toBe("");
    expect(attrs[MONITORING_LOG_ATTR.PROPERTIES]).toBe("");
  });

  it("should redact PII in input", () => {
    emitMonitoringLog(
      makeParams({
        toolArguments: { email: "user@example.com", query: "test" },
      }),
    );

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    const input = attrs[MONITORING_LOG_ATTR.INPUT] as string;
    expect(input).not.toContain("user@example.com");
    expect(input).toContain("[REDACTED:email]");
  });

  it("should redact PII in error message", () => {
    emitMonitoringLog(
      makeParams({
        isError: true,
        errorMessage: "Failed for user@example.com",
      }),
    );

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    const errorMsg = attrs[MONITORING_LOG_ATTR.ERROR_MESSAGE] as string;
    expect(errorMsg).not.toContain("user@example.com");
  });

  it("should serialize properties as JSON", () => {
    emitMonitoringLog(makeParams({ properties: { env: "prod", v: "2" } }));

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    expect(JSON.parse(attrs[MONITORING_LOG_ATTR.PROPERTIES] as string)).toEqual(
      { env: "prod", v: "2" },
    );
  });

  it("should be fail-safe when result contains circular references", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() =>
      emitMonitoringLog(makeParams({ result: circular })),
    ).not.toThrow();
  });

  it("should set severity based on isError", () => {
    emitMonitoringLog(makeParams({ isError: false }));
    emitMonitoringLog(makeParams({ isError: true }));

    expect(emittedRecords.length).toBe(2);
    expect(emittedRecords[0]!.severityText).toBe("INFO");
    expect(emittedRecords[1]!.severityText).toBe("ERROR");
  });

  it("should truncate output exceeding 64KB", () => {
    const largeOutput = { data: "x".repeat(70_000) };
    emitMonitoringLog(makeParams({ result: largeOutput }));

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    const output = attrs[MONITORING_LOG_ATTR.OUTPUT] as string;
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(65_536);
    expect(output).toContain("... [TRUNCATED]");
  }, 15_000);

  it("should truncate input exceeding 64KB", () => {
    const largeInput = { query: "y".repeat(70_000) };
    emitMonitoringLog(makeParams({ toolArguments: largeInput }));

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    const input = attrs[MONITORING_LOG_ATTR.INPUT] as string;
    expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(65_536);
    expect(input).toContain("... [TRUNCATED]");
  }, 15_000);

  it("should not truncate output under 64KB", () => {
    const smallOutput = { data: "hello" };
    emitMonitoringLog(makeParams({ result: smallOutput }));

    expect(emittedRecords.length).toBe(1);
    const attrs = emittedRecords[0]!.attributes!;
    const output = attrs[MONITORING_LOG_ATTR.OUTPUT] as string;
    expect(output).not.toContain("[TRUNCATED]");
    expect(JSON.parse(output)).toEqual({ data: "hello" });
  });
});
