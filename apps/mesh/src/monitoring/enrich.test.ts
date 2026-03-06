import { describe, it, expect } from "bun:test";
import { enrichMonitoringSpan } from "./enrich";
import { MESH_ATTR } from "./schema";

describe("enrichMonitoringSpan", () => {
  function createMockSpan() {
    const attrs: Record<string, string | number | boolean> = {};
    let ended = false;
    return {
      span: {
        setAttributes(a: Record<string, string | number | boolean>) {
          Object.assign(attrs, a);
        },
        end() {
          ended = true;
        },
      },
      getAttrs: () => attrs,
      isEnded: () => ended,
    };
  }

  it("should set all mesh.* span attributes", () => {
    const { span, getAttrs } = createMockSpan();

    enrichMonitoringSpan(span as any, {
      organizationId: "org_123",
      connectionId: "conn_456",
      connectionTitle: "My MCP Server",
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
    });

    const attrs = getAttrs();
    expect(attrs[MESH_ATTR.ORGANIZATION_ID]).toBe("org_123");
    expect(attrs[MESH_ATTR.CONNECTION_ID]).toBe("conn_456");
    expect(attrs[MESH_ATTR.CONNECTION_TITLE]).toBe("My MCP Server");
    expect(attrs[MESH_ATTR.TOOL_NAME]).toBe("EXAMPLE_TOOL");
    expect(attrs[MESH_ATTR.TOOL_IS_ERROR]).toBe(false);
    expect(attrs[MESH_ATTR.TOOL_DURATION_MS]).toBe(150);
    expect(attrs[MESH_ATTR.USER_ID]).toBe("user_789");
    expect(attrs[MESH_ATTR.REQUEST_ID]).toBe("req_abc");
    expect(attrs[MESH_ATTR.USER_AGENT]).toBe("cursor/1.0");
    expect(attrs[MESH_ATTR.VIRTUAL_MCP_ID]).toBe("vmcp_def");
    expect(JSON.parse(attrs[MESH_ATTR.TOOL_PROPERTIES] as string)).toEqual({
      env: "prod",
    });
  });

  it("should handle missing optional fields", () => {
    const { span, getAttrs } = createMockSpan();

    enrichMonitoringSpan(span as any, {
      organizationId: "org_123",
      connectionId: "conn_456",
      connectionTitle: "Server",
      toolName: "TOOL",
      toolArguments: {},
      result: { content: [] },
      duration: 0,
      isError: false,
      errorMessage: null,
      userId: null,
      requestId: "req_1",
      userAgent: null,
      virtualMcpId: null,
      properties: null,
    });

    const attrs = getAttrs();
    expect(attrs[MESH_ATTR.USER_ID]).toBe("");
    expect(attrs[MESH_ATTR.USER_AGENT]).toBe("");
    expect(attrs[MESH_ATTR.VIRTUAL_MCP_ID]).toBe("");
    expect(attrs[MESH_ATTR.TOOL_PROPERTIES]).toBe("");
  });

  it("should apply PII redaction to input, output, and error_message", () => {
    const { span, getAttrs } = createMockSpan();

    enrichMonitoringSpan(span as any, {
      organizationId: "org_123",
      connectionId: "conn_456",
      connectionTitle: "Server",
      toolName: "TOOL",
      toolArguments: { email: "user@example.com", query: "test" },
      result: { content: [{ type: "text", text: "ok" }] },
      duration: 0,
      isError: true,
      errorMessage:
        "Failed for user@example.com with token=sk-secret-456-long-enough",
      userId: null,
      requestId: "req_1",
      userAgent: null,
      virtualMcpId: null,
      properties: null,
    });

    const attrs = getAttrs();
    const input = attrs[MESH_ATTR.TOOL_INPUT] as string;
    // The email should be redacted in input
    expect(input).not.toContain("user@example.com");
    expect(input).toContain("[REDACTED:email]");
    // error_message should also be redacted
    const errorMsg = attrs[MESH_ATTR.TOOL_ERROR_MESSAGE] as string;
    expect(errorMsg).not.toContain("user@example.com");
  });

  it("should NOT set attributes when organizationId is empty", () => {
    const { span, getAttrs } = createMockSpan();

    enrichMonitoringSpan(span as any, {
      organizationId: "",
      connectionId: "conn_456",
      connectionTitle: "Server",
      toolName: "TOOL",
      toolArguments: {},
      result: { content: [] },
      duration: 0,
      isError: false,
      errorMessage: null,
      userId: null,
      requestId: "req_1",
      userAgent: null,
      virtualMcpId: null,
      properties: null,
    });

    const attrs = getAttrs();
    expect(Object.keys(attrs).length).toBe(0);
  });
});
