import { describe, it, expect, vi, mock, beforeEach } from "bun:test";
import type { MeshContext } from "@/core/mesh-context";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// Mock emitMonitoringLog before importing MonitoringTransport
const mockEmitMonitoringLog = vi.fn();
mock.module("@/monitoring/emit", () => ({
  emitMonitoringLog: mockEmitMonitoringLog,
}));

// Import after mock setup
const { MonitoringTransport } = await import("./monitoring");

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

describe("MonitoringTransport emitMonitoringLog", () => {
  beforeEach(() => {
    mockEmitMonitoringLog.mockReset();
  });

  it("should call emitMonitoringLog on tool call response", async () => {
    const { transport, simulateResponse } = createMockTransportAndCtx();

    transport.onmessage = vi.fn();
    await transport.start();

    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "MY_TOOL", arguments: { query: "hello" } },
    } as any);

    simulateResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "world" }],
        isError: false,
      },
    } as any);

    expect(mockEmitMonitoringLog).toHaveBeenCalledTimes(1);

    const [params] = mockEmitMonitoringLog.mock.calls[0]!;
    expect(params.organizationId).toBe("org_test");
    expect(params.connectionId).toBe("conn_1");
    expect(params.connectionTitle).toBe("Test Server");
    expect(params.toolName).toBe("MY_TOOL");
    expect(params.isError).toBe(false);
    expect(params.userId).toBe("user_1");
    expect(params.requestId).toBe("req_1");
    expect(params.userAgent).toBe("test/1.0");
  });

  it("should pass context (spanCtx) as second argument to emitMonitoringLog", async () => {
    const { transport, simulateResponse } = createMockTransportAndCtx();

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

    expect(mockEmitMonitoringLog).toHaveBeenCalledTimes(1);
    // Second argument should be the OTel context (not undefined)
    const contextArg = mockEmitMonitoringLog.mock.calls[0]![1];
    expect(contextArg).toBeDefined();
  });

  it("should call span.end() AFTER emitMonitoringLog", async () => {
    const { transport, simulateResponse, mockSpan } =
      createMockTransportAndCtx();

    let emitCalledBeforeEnd = false;
    mockEmitMonitoringLog.mockImplementation(() => {
      // At the time emitMonitoringLog is called, span should NOT be ended yet
      emitCalledBeforeEnd = !mockSpan.isEnded();
    });

    transport.onmessage = vi.fn();
    await transport.start();

    await transport.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "TOOL_C", arguments: {} },
    } as any);

    simulateResponse({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [], isError: false },
    } as any);

    // Span must have been ended
    expect(mockSpan.isEnded()).toBe(true);
    // And emitMonitoringLog was called BEFORE end()
    expect(emitCalledBeforeEnd).toBe(true);
  });

  it("should not call emitMonitoringLog for non-tool-call methods", async () => {
    const { transport, simulateResponse } = createMockTransportAndCtx();

    transport.onmessage = vi.fn();
    await transport.start();

    await transport.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
      params: {},
    } as any);

    simulateResponse({
      jsonrpc: "2.0",
      id: 10,
      result: { tools: [] },
    } as any);

    expect(mockEmitMonitoringLog).not.toHaveBeenCalled();
  });
});
