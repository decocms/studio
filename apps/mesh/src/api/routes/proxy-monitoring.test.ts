import { describe, expect, it, vi } from "bun:test";
import type { MeshContext } from "../../core/mesh-context";
import { MESH_ATTR } from "@/monitoring/schema";
import {
  createProxyMonitoringMiddleware,
  createProxyStreamableMonitoringMiddleware,
} from "./proxy-monitoring";

function createMockSpan() {
  const attrs: Record<string, unknown> = {};
  let ended = false;
  return {
    setAttributes(a: Record<string, unknown>) {
      Object.assign(attrs, a);
    },
    setAttribute(k: string, v: unknown) {
      attrs[k] = v;
    },
    recordException() {},
    end() {
      ended = true;
    },
    _attrs: attrs,
    _isEnded: () => ended,
  };
}

function createMockCtx(overrides?: {
  userAgent?: string;
  properties?: Record<string, string>;
}) {
  const hasUserAgentOverride = overrides && "userAgent" in overrides;
  const hasPropertiesOverride = overrides && "properties" in overrides;

  const spans: ReturnType<typeof createMockSpan>[] = [];

  const ctx = {
    organization: { id: "org_1" },
    auth: { user: { id: "user_1" } },
    storage: {
      monitoring: {},
      tags: { getUserTagsInOrg: vi.fn(async () => []) },
    },
    metadata: {
      requestId: "req_1",
      userAgent: hasUserAgentOverride ? overrides.userAgent : "test-client/1.0",
      properties: hasPropertiesOverride ? overrides.properties : undefined,
    },
    tracer: {
      startSpan: () => {
        const s = createMockSpan();
        spans.push(s);
        return s;
      },
    },
  } as unknown as MeshContext;

  return { ctx, spans };
}

describe("proxy monitoring middleware", () => {
  it("emits span with correct attributes for auth-denied CallToolResult", async () => {
    const { ctx, spans } = createMockCtx();

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
    expect(spans.length).toBe(1);

    const attrs = spans[0]!._attrs;
    expect(attrs[MESH_ATTR.TOOL_NAME]).toBe("foo");
    expect(attrs[MESH_ATTR.CONNECTION_ID]).toBe("conn_1");
    expect(attrs[MESH_ATTR.TOOL_IS_ERROR]).toBe(true);
    expect(spans[0]!._isEnded()).toBe(true);
    // Writes go through OTel pipeline, not storage
  });

  it("emits span for auth-denied streamable Response (403)", async () => {
    const { ctx, spans } = createMockCtx();

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
    // Caller can still read the body
    expect(await response.json()).toEqual({
      structuredContent: { error: "nope" },
      content: [{ type: "text", text: "Authorization failed: nope" }],
    });

    // Span emitted asynchronously — poll until it arrives
    const deadline = Date.now() + 1000;
    while (spans.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(spans.length).toBe(1);
    expect(spans[0]!._attrs[MESH_ATTR.TOOL_NAME]).toBe("foo");
    expect(spans[0]!._attrs[MESH_ATTR.TOOL_IS_ERROR]).toBe(true);
    expect(spans[0]!._isEnded()).toBe(true);
  });

  it("sets empty userAgent when not provided", async () => {
    const { ctx, spans } = createMockCtx({
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

    expect(spans.length).toBe(1);
    expect(spans[0]!._attrs[MESH_ATTR.USER_AGENT]).toBe("");
  });

  it("extracts properties from _meta.properties in arguments", async () => {
    const { ctx, spans } = createMockCtx();

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

    expect(spans.length).toBe(1);
    const props = JSON.parse(
      spans[0]!._attrs[MESH_ATTR.TOOL_PROPERTIES] as string,
    );
    expect(props).toEqual({
      thread_id: "thread_123",
      trace_id: "trace_456",
    });
  });

  it("merges header properties with _meta.properties (header takes precedence)", async () => {
    const { ctx, spans } = createMockCtx({
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

    expect(spans.length).toBe(1);
    const props = JSON.parse(
      spans[0]!._attrs[MESH_ATTR.TOOL_PROPERTIES] as string,
    );
    // Header properties take precedence
    expect(props).toEqual({
      thread_id: "header_thread",
      source: "header",
      extra: "from_meta",
    });
  });

  it("logs properties from header when no _meta.properties", async () => {
    const { ctx, spans } = createMockCtx({
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

    expect(spans.length).toBe(1);
    const props = JSON.parse(
      spans[0]!._attrs[MESH_ATTR.TOOL_PROPERTIES] as string,
    );
    expect(props).toEqual({ env: "production", region: "us-east" });
  });

  it("ignores non-string values in _meta.properties", async () => {
    const { ctx, spans } = createMockCtx();

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

    expect(spans.length).toBe(1);
    const props = JSON.parse(
      spans[0]!._attrs[MESH_ATTR.TOOL_PROPERTIES] as string,
    );
    // Only string values should be included
    expect(props).toEqual({ valid_string: "yes" });
  });
});
