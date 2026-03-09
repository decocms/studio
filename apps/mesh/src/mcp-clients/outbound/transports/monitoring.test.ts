import { describe, it, expect, vi } from "bun:test";
import { MonitoringTransport } from "./monitoring";
import { MESH_ATTR } from "@/monitoring/schema";
import type { MeshContext } from "@/core/mesh-context";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

function createMockSpan() {
  const attrs: Record<string, unknown> = {};
  const events: { name: string; error?: Error }[] = [];
  let ended = false;
  return {
    span: {
      setAttributes(a: Record<string, unknown>) {
        Object.assign(attrs, a);
      },
      setAttribute(k: string, v: unknown) {
        attrs[k] = v;
      },
      recordException(err: Error) {
        events.push({ name: "exception", error: err });
      },
      end() {
        ended = true;
      },
    },
    getAttrs: () => attrs,
    isEnded: () => ended,
    getEvents: () => events,
  };
}

function createMockTransportAndCtx() {
  const mockSpan = createMockSpan();

  // Mock inner transport that captures onmessage for simulating responses
  let innerOnMessage: ((msg: JSONRPCMessage) => void) | undefined;
  const innerTransport: Transport = {
    async start() {},
    async send(_msg: JSONRPCMessage) {},
    async close() {},
    set onmessage(fn: ((msg: JSONRPCMessage) => void) | undefined) {
      innerOnMessage = fn;
    },
    get onmessage() {
      return innerOnMessage;
    },
    onerror: undefined,
    onclose: undefined,
  };

  const ctx = {
    organization: { id: "org_test" },
    auth: { user: { id: "user_1" } },
    storage: { monitoring: {} },
    metadata: {
      requestId: "req_1",
      userAgent: "test/1.0",
      properties: undefined,
    },
    tracer: {
      startSpan: () => mockSpan.span,
    },
    meter: {
      createHistogram: () => ({ record: vi.fn() }),
      createCounter: () => ({ add: vi.fn() }),
    },
  } as unknown as MeshContext;

  const transport = new MonitoringTransport(innerTransport, {
    ctx,
    connectionId: "conn_1",
    connectionTitle: "Test Server",
  });

  return {
    transport,
    innerTransport,
    ctx,
    mockSpan,
    simulateResponse: (msg: JSONRPCMessage) => {
      innerOnMessage?.(msg);
    },
  };
}

describe("MonitoringTransport span enrichment", () => {
  it("should set mesh.* span attributes on tool call response", async () => {
    const { transport, simulateResponse, mockSpan } =
      createMockTransportAndCtx();

    // Wire up message callbacks
    transport.onmessage = vi.fn();
    await transport.start();

    // Send a tools/call request
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "MY_TOOL", arguments: { query: "hello" } },
    } as any);

    // Simulate response from inner transport
    simulateResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "world" }],
        isError: false,
      },
    } as any);

    const attrs = mockSpan.getAttrs();
    expect(attrs[MESH_ATTR.ORGANIZATION_ID]).toBe("org_test");
    expect(attrs[MESH_ATTR.CONNECTION_ID]).toBe("conn_1");
    expect(attrs[MESH_ATTR.CONNECTION_TITLE]).toBe("Test Server");
    expect(attrs[MESH_ATTR.TOOL_NAME]).toBe("MY_TOOL");
    expect(attrs[MESH_ATTR.TOOL_IS_ERROR]).toBe(false);
    expect(attrs[MESH_ATTR.USER_ID]).toBe("user_1");
    expect(attrs[MESH_ATTR.REQUEST_ID]).toBe("req_1");
    expect(attrs[MESH_ATTR.USER_AGENT]).toBe("test/1.0");
  });

  it("should call span.end() AFTER enrichMonitoringSpan", async () => {
    const { transport, simulateResponse, mockSpan } =
      createMockTransportAndCtx();

    // Patch span.end to capture whether attrs were set first
    let attrsAtEnd: Record<string, unknown> = {};
    const originalEnd = mockSpan.span.end;
    mockSpan.span.end = () => {
      attrsAtEnd = { ...mockSpan.getAttrs() };
      originalEnd.call(mockSpan.span);
    };

    transport.onmessage = vi.fn();
    await transport.start();

    await transport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "TOOL_B", arguments: {} },
    } as any);

    simulateResponse({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [], isError: false },
    } as any);

    // Span must have been ended
    expect(mockSpan.isEnded()).toBe(true);
    // And attrs were set BEFORE end() was called
    expect(attrsAtEnd[MESH_ATTR.TOOL_NAME]).toBe("TOOL_B");
  });
});
