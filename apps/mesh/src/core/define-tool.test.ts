import {
  SpanStatusCode,
  type Span,
  type SpanOptions,
  type Tracer,
  type Meter,
} from "@opentelemetry/api";
import { describe, expect, it, vi } from "bun:test";
import { z } from "zod";
import { AccessControl } from "./access-control";
import { defineTool } from "./define-tool";
import type { MeshContext } from "./mesh-context";
import type { EventBus } from "../event-bus/interface";

// Mock MeshContext
const createMockContext = (): MeshContext => ({
  timings: {
    measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
  },
  auth: {
    user: {
      id: "user_1",
      email: "[email protected]",
      name: "Test",
      role: "admin",
    },
  },
  organization: {
    id: "org_123",
    slug: "test-org",
    name: "Test Organization",
  },
  storage: {
    connections: null as never,
    organizationSettings: {
      get: vi.fn(),
      upsert: vi.fn(),
    } as never,
    threads: null as never,
    monitoring: {
      log: vi.fn().mockResolvedValue(undefined),
      logBatch: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
      getStats: vi.fn().mockResolvedValue({
        totalCalls: 0,
        errorRate: 0,
        avgDurationMs: 0,
      }),
    } as never,
    virtualMcps: null as never,
    users: null as never,
    tags: null as never,
    projects: null as never,
    projectConnections: null as never,
    projectPluginConfigs: null as never,
    monitoringDashboards: null as never,
    aiProviderKeys: null as never,
    oauthPkceStates: null as never,
    automations: null as never,
  },
  vault: null as never,
  authInstance: null as never,
  boundAuth: {
    hasPermission: async () => false,
    organization: {
      create: async () => ({ data: null, error: null }),
      update: async () => ({ data: null, error: null }),
      delete: async () => {},
      get: async () => ({ data: null, error: null }),
      list: async () => ({ data: [], error: null }),
      addMember: async () => ({ data: null, error: null }),
      removeMember: async () => {},
      listMembers: async () => ({ data: [], error: null }),
      updateMemberRole: async () => ({ data: null, error: null }),
    },
  } as never,
  access: {
    granted: vi.fn().mockReturnValue(true),
    check: vi.fn().mockResolvedValue(undefined),
    grant: vi.fn(),
    setToolName: vi.fn(),
  } as Partial<AccessControl> as AccessControl,
  db: null as never,
  tracer: {
    startActiveSpan: vi.fn(
      <T>(_name: string, _opts: SpanOptions, fn: (span: Span) => T): T =>
        fn({
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
          spanContext: vi.fn().mockReturnValue({ traceId: "trace_123" }),
          setAttribute: vi.fn(),
        } as Partial<Span> as Span),
    ),
  } as unknown as Tracer,
  meter: {
    createHistogram: vi.fn().mockReturnValue({
      record: vi.fn(),
    }),
    createCounter: vi.fn().mockReturnValue({
      add: vi.fn(),
    }),
  } as Partial<Meter> as Meter,
  baseUrl: "https://mesh.example.com",
  metadata: {
    requestId: "req_123",
    timestamp: new Date(),
  },
  eventBus: {
    publish: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn().mockResolvedValue({}),
    unsubscribe: vi.fn().mockResolvedValue({ success: true }),
    listSubscriptions: vi.fn().mockResolvedValue([]),
    getSubscription: vi.fn().mockResolvedValue(null),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
  } as unknown as EventBus,
  aiProviders: null as never,
  createMCPProxy: vi.fn().mockResolvedValue({}),
  getOrCreateClient: vi.fn().mockResolvedValue({}),
});

describe("defineTool", () => {
  describe("tool creation", () => {
    it("should create a tool with execute method", () => {
      const tool = defineTool({
        name: "TEST_TOOL",
        description: "A test tool",
        inputSchema: z.object({
          message: z.string(),
        }),
        outputSchema: z.object({
          result: z.string(),
        }),
        handler: async (input) => {
          return { result: `Echo: ${input.message}` };
        },
      });

      expect(tool.name).toBe("TEST_TOOL");
      expect(tool.description).toBe("A test tool");
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    it("should preserve original properties", () => {
      const inputSchema = z.object({ value: z.number() });
      const outputSchema = z.object({ result: z.number() });
      const handler = vi.fn();

      const tool = defineTool({
        name: "MY_TOOL",
        description: "Test",
        inputSchema,
        outputSchema,
        handler,
      });

      expect(tool.inputSchema).toBe(inputSchema);
      expect(tool.outputSchema).toBe(outputSchema);
      expect(tool.handler).toBe(handler);
    });
  });

  describe("tool execution", () => {
    it("should execute tool handler", async () => {
      const handler = vi.fn(async (input: { value: number }) => {
        return { doubled: input.value * 2 };
      });

      const tool = defineTool({
        name: "DOUBLE",
        description: "Double a number",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ doubled: z.number() }),
        handler,
      });

      const ctx = createMockContext();
      const result = await tool.execute({ value: 5 }, ctx);

      expect(handler).toHaveBeenCalledWith({ value: 5 }, ctx);
      expect(result).toEqual({ doubled: 10 });
    });

    it("should set tool name in context", async () => {
      const tool = defineTool({
        name: "SET_NAME_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async (_input, ctx) => {
          expect(ctx.toolName).toBe("SET_NAME_TOOL");
          return {};
        },
      });

      const ctx = createMockContext();
      await tool.execute({}, ctx);
    });

    it("should start OpenTelemetry span", async () => {
      const tool = defineTool({
        name: "TRACED_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async () => ({}),
      });

      const ctx = createMockContext();
      await tool.execute({}, ctx);

      expect(ctx.tracer.startActiveSpan).toHaveBeenCalledWith(
        "tool.TRACED_TOOL",
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe("monitoring metrics", () => {
    it("does not record tool execution metrics on success", async () => {
      const tool = defineTool({
        name: "METRIC_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async () => ({}),
      });

      const ctx = createMockContext();
      await tool.execute({}, ctx);

      expect(ctx.meter.createHistogram).not.toHaveBeenCalled();
    });

    it("does not record tool execution counters on success", async () => {
      const tool = defineTool({
        name: "COUNTER_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async () => ({}),
      });

      const ctx = createMockContext();
      await tool.execute({}, ctx);

      expect(ctx.meter.createCounter).not.toHaveBeenCalled();
    });

    it("does not record tool execution metrics on failure", async () => {
      const tool = defineTool({
        name: "ERROR_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async () => {
          throw new Error("Test error");
        },
      });

      const ctx = createMockContext();

      await expect(tool.execute({}, ctx)).rejects.toThrow("Test error");
      expect(ctx.meter.createCounter).not.toHaveBeenCalled();
      expect(ctx.meter.createHistogram).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should propagate handler errors", async () => {
      const tool = defineTool({
        name: "ERROR_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async () => {
          throw new Error("Handler error");
        },
      });

      const ctx = createMockContext();

      await expect(tool.execute({}, ctx)).rejects.toThrow("Handler error");
    });

    it("should record exception in span", async () => {
      const tool = defineTool({
        name: "EXCEPTION_TOOL",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: async () => {
          throw new Error("Test exception");
        },
      });

      const ctx = createMockContext();
      const mockSpan = {
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      } as Partial<Span> as Span;

      ctx.tracer.startActiveSpan = vi.fn(
        <T>(_name: string, _opts: SpanOptions, fn: (span: Span) => T): T =>
          fn(mockSpan),
      ) as unknown as Tracer["startActiveSpan"];

      await expect(tool.execute({}, ctx)).rejects.toThrow();
      expect(mockSpan.recordException).toHaveBeenCalled();
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR }),
      );
    });
  });
});
