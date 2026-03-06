import { describe, expect, it, vi } from "bun:test";
import type { MeshContext } from "../../core/mesh-context";
import {
  createProxyMonitoringMiddleware,
  createProxyStreamableMonitoringMiddleware,
} from "./proxy-monitoring";
import { MONITORING_SPAN_NAME } from "@/monitoring/parquet-schema";

function createMockCtx(overrides?: {
  userAgent?: string;
  properties?: Record<string, string>;
}) {
  const log = vi.fn(async (_event: unknown) => {});

  // Mock span that captures setAttributes calls
  const spanAttributes: Record<string, unknown>[] = [];
  const mockSpan = {
    setAttributes: vi.fn((attrs: Record<string, unknown>) => {
      spanAttributes.push(attrs);
    }),
    end: vi.fn(),
  };
  const startSpan = vi.fn((_name: string) => mockSpan);

  // Use defaults unless explicitly overridden (including with undefined)
  const hasUserAgentOverride = overrides && "userAgent" in overrides;
  const hasPropertiesOverride = overrides && "properties" in overrides;

  const ctx = {
    organization: { id: "org_1" },
    auth: { user: { id: "user_1" } },
    storage: { monitoring: { log } },
    tracer: { startSpan },
    metadata: {
      requestId: "req_1",
      userAgent: hasUserAgentOverride ? overrides.userAgent : "test-client/1.0",
      properties: hasPropertiesOverride ? overrides.properties : undefined,
    },
  } as unknown as MeshContext;

  return { ctx, log, startSpan, mockSpan, spanAttributes };
}

describe("proxy monitoring middleware", () => {
  it("logs auth-denied CallToolResult (isError=true) even if auth returns early", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx();

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: { name: "foo", arguments: { a: 1 } },
    } as any;

    const result = await middleware(request, async () => {
      return {
        structuredContent: { reason: "nope" },
        content: [{ type: "text", text: "Authorization failed: nope" }],
        isError: true,
      } as any;
    });

    expect(result.isError).toBe(true);
    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);

    const attrs = spanAttributes[0] as Record<string, unknown>;
    expect(attrs["mesh.monitoring.tool_name"]).toBe("foo");
    expect(attrs["mesh.monitoring.connection_id"]).toBe("conn_1");
    expect(attrs["mesh.monitoring.is_error"]).toBe(true);
    expect(attrs["mesh.monitoring.error_message"]).toContain(
      "Authorization failed",
    );
    expect(attrs["mesh.monitoring.user_agent"]).toBe("test-client/1.0");
  });

  it("logs auth-denied streamable Response (403) without consuming the body", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx();

    const middleware = createProxyStreamableMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: { name: "foo", arguments: { a: 1 } },
    } as any;

    const response = await middleware(request, async () => {
      return new Response(
        JSON.stringify({
          structuredContent: { error: "nope" },
          content: [{ type: "text", text: "Authorization failed: nope" }],
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      structuredContent: { error: "nope" },
      content: [{ type: "text", text: "Authorization failed: nope" }],
    });

    // Logging happens after the stream finishes (async).
    await new Promise((r) => setTimeout(r, 50));
    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);

    const attrs = spanAttributes[0] as Record<string, unknown>;
    expect(attrs["mesh.monitoring.tool_name"]).toBe("foo");
    expect(attrs["mesh.monitoring.is_error"]).toBe(true);
    expect(attrs["mesh.monitoring.user_agent"]).toBe("test-client/1.0");
  });

  it("logs without userAgent when not provided", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx({
      userAgent: undefined,
    });

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: { name: "bar", arguments: {} },
    } as any;

    await middleware(request, async () => {
      return { content: [], isError: false } as any;
    });

    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);
    const attrs = spanAttributes[0] as Record<string, unknown>;
    expect(attrs["mesh.monitoring.user_agent"]).toBe("");
  });

  it("extracts properties from _meta.properties in arguments", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx();

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: {
        name: "test_tool",
        arguments: {
          input: "value",
          _meta: {
            properties: { thread_id: "thread_123", trace_id: "trace_456" },
          },
        },
      },
    } as any;

    await middleware(request, async () => {
      return { content: [], isError: false } as any;
    });

    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);
    const attrs = spanAttributes[0] as Record<string, unknown>;
    const props = JSON.parse(attrs["mesh.monitoring.properties"] as string);
    expect(props).toEqual({
      thread_id: "thread_123",
      trace_id: "trace_456",
    });
  });

  it("merges header properties with _meta.properties (header takes precedence)", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx({
      properties: { thread_id: "header_thread", source: "header" },
    });

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: {
        name: "test_tool",
        arguments: {
          _meta: {
            properties: { thread_id: "meta_thread", extra: "from_meta" },
          },
        },
      },
    } as any;

    await middleware(request, async () => {
      return { content: [], isError: false } as any;
    });

    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);
    const attrs = spanAttributes[0] as Record<string, unknown>;
    const props = JSON.parse(attrs["mesh.monitoring.properties"] as string);
    expect(props).toEqual({
      thread_id: "header_thread",
      source: "header",
      extra: "from_meta",
    });
  });

  it("logs properties from header when no _meta.properties", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx({
      properties: { env: "production", region: "us-east" },
    });

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: { name: "test_tool", arguments: { foo: "bar" } },
    } as any;

    await middleware(request, async () => {
      return { content: [], isError: false } as any;
    });

    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);
    const attrs = spanAttributes[0] as Record<string, unknown>;
    const props = JSON.parse(attrs["mesh.monitoring.properties"] as string);
    expect(props).toEqual({ env: "production", region: "us-east" });
  });

  it("ignores non-string values in _meta.properties", async () => {
    const { ctx, startSpan, spanAttributes } = createMockCtx();

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
      connectionTitle: "Test Connection",
    });

    const request = {
      method: "tools/call",
      params: {
        name: "test_tool",
        arguments: {
          _meta: {
            properties: {
              valid_string: "yes",
              invalid_number: 123,
              invalid_object: { nested: true },
              invalid_array: ["a", "b"],
            },
          },
        },
      },
    } as any;

    await middleware(request, async () => {
      return { content: [], isError: false } as any;
    });

    expect(startSpan).toHaveBeenCalledWith(MONITORING_SPAN_NAME);
    const attrs = spanAttributes[0] as Record<string, unknown>;
    const props = JSON.parse(attrs["mesh.monitoring.properties"] as string);
    expect(props).toEqual({ valid_string: "yes" });
  });
});
