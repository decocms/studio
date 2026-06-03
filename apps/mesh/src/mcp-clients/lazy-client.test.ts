/**
 * Integration tests for lazy-client + circuit breaker
 *
 * Tests that the circuit breaker correctly protects the system when downstream
 * MCP servers are unreachable, and that it recovers when they come back.
 *
 * Uses a real MCP Server + bridge transport to simulate a working downstream,
 * and mocks clientFromConnection to control when connections fail.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createBridgeTransportPair } from "@decocms/mesh-sdk";
import { CircuitOpenError, resetAll } from "./circuit-breaker";
import { createLazyClient } from "./lazy-client";
import type { ConnectionEntity } from "../tools/connection/schema";
import type { StudioContext } from "../core/studio-context";

// Mock clientFromConnection — we control when it succeeds/fails
const clientFromConnectionMock = mock(() =>
  Promise.resolve(new Client({ name: "mock", version: "1.0.0" })),
);

mock.module("./client", () => ({
  clientFromConnection: clientFromConnectionMock,
}));

const fakeConnection = {
  id: "conn_test_123",
  connection_type: "HTTP",
} as unknown as ConnectionEntity;

const fakeCtx = {
  pendingRevalidations: [],
} as unknown as StudioContext;

/**
 * Helper: create a real MCP server with a tool, connect a client to it via bridge,
 * and return the connected client.
 */
async function createWorkingClient(): Promise<Client> {
  const server = new McpServer({ name: "test-downstream", version: "1.0.0" });

  server.tool("echo", { message: z.string() }, async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  }));

  const { client: clientTransport, server: serverTransport } =
    createBridgeTransportPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return client;
}

describe("lazy-client with circuit breaker", () => {
  beforeEach(() => {
    resetAll();
    clientFromConnectionMock.mockReset();
  });

  it("works normally when downstream is healthy", async () => {
    const realClient = await createWorkingClient();
    clientFromConnectionMock.mockResolvedValue(realClient);

    const lazy = createLazyClient(fakeConnection, fakeCtx, false);
    const result = await lazy.listTools();

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("echo");
  });

  it("retries on first failure (circuit stays closed)", async () => {
    clientFromConnectionMock.mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const lazy = createLazyClient(fakeConnection, fakeCtx, false);

    // First call fails
    expect(lazy.listTools()).rejects.toThrow("Connection refused");

    // Second call should retry (circuit is still closed after 1 failure)
    const realClient = await createWorkingClient();
    clientFromConnectionMock.mockResolvedValue(realClient);

    const result = await lazy.listTools();
    expect(result.tools).toHaveLength(1);
  });

  it("opens circuit after 3 consecutive failures and fails fast", async () => {
    clientFromConnectionMock.mockRejectedValue(new Error("Connection refused"));

    // Fail 3 times (each creates a new lazy client, same connection ID)
    for (let i = 0; i < 3; i++) {
      const lazy = createLazyClient(fakeConnection, fakeCtx, false);
      expect(lazy.listTools()).rejects.toThrow("Connection refused");
    }

    // 4th call should fail fast with CircuitOpenError
    const lazy = createLazyClient(fakeConnection, fakeCtx, false);
    const start = Date.now();

    try {
      await lazy.listTools();
      throw new Error("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      expect(Date.now() - start).toBeLessThan(50); // fail-fast, no 60s wait
    }
  });

  it("circuit breaker is shared across lazy client instances (same connection ID)", async () => {
    clientFromConnectionMock.mockRejectedValue(new Error("timeout"));

    // Each lazy client instance is independent, but circuit state is shared by connection ID
    const lazy1 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy1.listTools()).rejects.toThrow("timeout");

    const lazy2 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy2.listTools()).rejects.toThrow("timeout");

    const lazy3 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy3.listTools()).rejects.toThrow("timeout");

    // Now circuit is open — new instance should fail fast
    const lazy4 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy4.listTools()).rejects.toThrow(CircuitOpenError);
  });

  it("different connections have independent circuits", async () => {
    clientFromConnectionMock.mockRejectedValue(new Error("timeout"));

    // Trip the circuit for conn_test_123
    for (let i = 0; i < 3; i++) {
      const lazy = createLazyClient(fakeConnection, fakeCtx, false);
      expect(lazy.listTools()).rejects.toThrow("timeout");
    }

    // conn_test_123 is open
    const lazy1 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy1.listTools()).rejects.toThrow(CircuitOpenError);

    // Different connection should still work
    const otherConnection = {
      ...fakeConnection,
      id: "conn_other_456",
    } as unknown as ConnectionEntity;
    const realClient = await createWorkingClient();
    clientFromConnectionMock.mockResolvedValue(realClient);

    const lazy2 = createLazyClient(otherConnection, fakeCtx, false);
    const result = await lazy2.listTools();
    expect(result.tools).toHaveLength(1);
  });

  it("callTool also respects circuit breaker", async () => {
    clientFromConnectionMock.mockRejectedValue(new Error("timeout"));

    // Trip the circuit
    for (let i = 0; i < 3; i++) {
      const lazy = createLazyClient(fakeConnection, fakeCtx, false);
      await expect(
        lazy.callTool({ name: "echo", arguments: { message: "hi" } }),
      ).rejects.toThrow("timeout");
    }

    // callTool should fail fast too
    const lazy = createLazyClient(fakeConnection, fakeCtx, false);
    await expect(
      lazy.callTool({ name: "echo", arguments: { message: "hi" } }),
    ).rejects.toThrow(CircuitOpenError);
  });

  it("circuit recovers after success", async () => {
    clientFromConnectionMock.mockRejectedValue(new Error("timeout"));

    // 2 failures (not yet open)
    for (let i = 0; i < 2; i++) {
      const lazy = createLazyClient(fakeConnection, fakeCtx, false);
      expect(lazy.listTools()).rejects.toThrow("timeout");
    }

    // Now succeed — resets circuit
    const realClient = await createWorkingClient();
    clientFromConnectionMock.mockResolvedValue(realClient);

    const lazy = createLazyClient(fakeConnection, fakeCtx, false);
    const result = await lazy.listTools();
    expect(result.tools).toHaveLength(1);

    // Fail 2 more times — circuit should still be closed (reset after success)
    clientFromConnectionMock.mockRejectedValue(new Error("timeout again"));

    for (let i = 0; i < 2; i++) {
      const lazy2 = createLazyClient(fakeConnection, fakeCtx, false);
      expect(lazy2.listTools()).rejects.toThrow("timeout again");
    }

    // Still closed (only 2 failures after reset)
    clientFromConnectionMock.mockRejectedValue(new Error("timeout again"));
    const lazy3 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy3.listTools()).rejects.toThrow("timeout again");

    // NOW it's open (3rd failure)
    const lazy4 = createLazyClient(fakeConnection, fakeCtx, false);
    expect(lazy4.listTools()).rejects.toThrow(CircuitOpenError);
  });
});
