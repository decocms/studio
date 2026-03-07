import { describe, it, expect } from "bun:test";
import {
  MESH_ATTR,
  MONITORING_SPAN_NAME,
  DEFAULT_MONITORING_DATA_PATH,
  spanToMonitoringRow,
} from "./schema";

describe("monitoring schema", () => {
  it("should define all mesh attribute key constants", () => {
    expect(MESH_ATTR.ORGANIZATION_ID).toBe("mesh.organization.id");
    expect(MESH_ATTR.CONNECTION_ID).toBe("mesh.connection.id");
    expect(MESH_ATTR.CONNECTION_TITLE).toBe("mesh.connection.title");
    expect(MESH_ATTR.TOOL_NAME).toBe("mesh.tool.name");
    expect(MESH_ATTR.TOOL_INPUT).toBe("mesh.tool.input");
    expect(MESH_ATTR.TOOL_OUTPUT).toBe("mesh.tool.output");
    expect(MESH_ATTR.TOOL_IS_ERROR).toBe("mesh.tool.is_error");
    expect(MESH_ATTR.TOOL_ERROR_MESSAGE).toBe("mesh.tool.error_message");
    expect(MESH_ATTR.TOOL_DURATION_MS).toBe("mesh.tool.duration_ms");
    expect(MESH_ATTR.USER_ID).toBe("mesh.user.id");
    expect(MESH_ATTR.REQUEST_ID).toBe("mesh.request.id");
    expect(MESH_ATTR.USER_AGENT).toBe("mesh.user_agent");
    expect(MESH_ATTR.VIRTUAL_MCP_ID).toBe("mesh.virtual_mcp.id");
    expect(MESH_ATTR.TOOL_PROPERTIES).toBe("mesh.tool.properties");
  });

  it("should define shared constants", () => {
    expect(MONITORING_SPAN_NAME).toBe("mcp.proxy.callTool");
    expect(DEFAULT_MONITORING_DATA_PATH).toContain("deco");
    expect(DEFAULT_MONITORING_DATA_PATH).toContain("monitoring");
  });

  it("should convert a span-like object to a monitoring row", () => {
    const attrs: Record<string, string | number | boolean> = {
      [MESH_ATTR.ORGANIZATION_ID]: "org_123",
      [MESH_ATTR.CONNECTION_ID]: "conn_456",
      [MESH_ATTR.CONNECTION_TITLE]: "My MCP Server",
      [MESH_ATTR.TOOL_NAME]: "EXAMPLE_TOOL",
      [MESH_ATTR.TOOL_INPUT]: '{"query": "test"}',
      [MESH_ATTR.TOOL_OUTPUT]: '{"result": "ok"}',
      [MESH_ATTR.TOOL_IS_ERROR]: false,
      [MESH_ATTR.TOOL_ERROR_MESSAGE]: "",
      [MESH_ATTR.TOOL_DURATION_MS]: 150,
      [MESH_ATTR.USER_ID]: "user_789",
      [MESH_ATTR.REQUEST_ID]: "req_abc",
      [MESH_ATTR.USER_AGENT]: "cursor/1.0",
      [MESH_ATTR.VIRTUAL_MCP_ID]: "vmcp_def",
      [MESH_ATTR.TOOL_PROPERTIES]: '{"env": "prod"}',
    };

    const row = spanToMonitoringRow({
      spanId: "span_001",
      startTimeUnixNano: 1709683200000000000n,
      attributes: attrs,
    });

    expect(row.id).toBe("span_001");
    expect(row.organization_id).toBe("org_123");
    expect(row.connection_id).toBe("conn_456");
    expect(row.tool_name).toBe("EXAMPLE_TOOL");
    expect(row.is_error).toBe(0);
    expect(row.duration_ms).toBe(150);
    expect(typeof row.timestamp).toBe("string");
    // Verify it's a valid ISO string
    expect(new Date(row.timestamp).toISOString()).toBe(row.timestamp);
  });

  it("should handle missing optional fields as null", () => {
    const attrs: Record<string, string | number | boolean> = {
      [MESH_ATTR.ORGANIZATION_ID]: "org_123",
      [MESH_ATTR.CONNECTION_ID]: "conn_456",
      [MESH_ATTR.CONNECTION_TITLE]: "Server",
      [MESH_ATTR.TOOL_NAME]: "TOOL",
      [MESH_ATTR.TOOL_INPUT]: "{}",
      [MESH_ATTR.TOOL_OUTPUT]: "{}",
      [MESH_ATTR.TOOL_IS_ERROR]: false,
      [MESH_ATTR.TOOL_DURATION_MS]: 0,
      [MESH_ATTR.REQUEST_ID]: "req_1",
    };

    const row = spanToMonitoringRow({
      spanId: "span_002",
      startTimeUnixNano: 1709683200000000000n,
      attributes: attrs,
    });

    expect(row.user_id).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.virtual_mcp_id).toBeNull();
    expect(row.properties).toBeNull();
    expect(row.error_message).toBeNull();
  });
});
