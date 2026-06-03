import { describe, expect, it, vi } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { createProxyMonitoringMiddleware } from "./proxy-monitoring";

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
  const recordHistogram = vi.fn();
  const addCounter = vi.fn();
  const createHistogram = vi.fn(() => ({ record: recordHistogram }));
  const createCounter = vi.fn(() => ({ add: addCounter }));

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
    meter: {
      createHistogram,
      createCounter,
    },
  } as unknown as StudioContext;

  return { ctx, spans, createHistogram, createCounter };
}

describe("proxy monitoring middleware", () => {
  it("creates and ends a correlation span for CallToolResult", async () => {
    const { ctx, spans, createHistogram, createCounter } = createMockCtx();

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
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
    expect(spans[0]!._isEnded()).toBe(true);
    expect(createHistogram).toHaveBeenCalledWith(
      "tool.execution.duration",
      expect.any(Object),
    );
    expect(createCounter).toHaveBeenCalledWith(
      "tool.execution.count",
      expect.any(Object),
    );
  });

  it("does not create span when monitoring is disabled", async () => {
    const { ctx, spans } = createMockCtx();

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: false,
      connectionId: "conn_1",
    });

    const request = {
      method: "tools/call",
      params: { name: "bar", arguments: {} },
    } as any;

    await middleware(request, async () => {
      return { content: [], isError: false } as any;
    });

    expect(spans.length).toBe(0);
  });

  it("creates span on tool call error (exception)", async () => {
    const { ctx, spans } = createMockCtx();

    const middleware = createProxyMonitoringMiddleware({
      ctx,
      enabled: true,
      connectionId: "conn_1",
    });

    const request = {
      method: "tools/call",
      params: { name: "crash_tool", arguments: {} },
    } as any;

    await expect(
      middleware(request, async () => {
        throw new Error("tool exploded");
      }),
    ).rejects.toThrow("tool exploded");

    expect(spans.length).toBe(1);
    expect(spans[0]!._isEnded()).toBe(true);
  });
});
