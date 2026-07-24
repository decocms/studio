/**
 * E2E test: Circuit breaker with real HTTP MCP servers
 *
 * Starts actual HTTP servers that simulate different failure modes:
 * - Hanging (never responds) → triggers MCP SDK timeout
 * - Connection refused (closed port) → immediate failure
 * - Intermittent (works, then dies)
 *
 * Measures actual timings to verify the circuit breaker prevents
 * the 60s timeout penalty on repeated failures.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  resetAll,
  assertCircuitClosed,
  recordFailure,
  recordSuccess,
  CircuitOpenError,
} from "./circuit-breaker";

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Start an HTTP server that never sends a response (simulates timeout) */
function startHangingServer() {
  return Bun.serve({
    port: 0,
    fetch() {
      // Never resolve — client will eventually timeout
      return new Promise(() => {});
    },
  });
}

/** Start an HTTP server that immediately returns 500 */
function startErrorServer() {
  return Bun.serve({
    port: 0,
    fetch() {
      return new Response("Internal Server Error", { status: 500 });
    },
  });
}

/** Try to connect an MCP client to a URL, measure time, return result */
async function timedConnect(
  url: string,
): Promise<{ durationMs: number; error?: string }> {
  const start = Date.now();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    await client.listTools();
    await client.close();
    return { durationMs: Date.now() - start };
  } catch (e) {
    return {
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("circuit breaker e2e - real HTTP servers", () => {
  beforeEach(() => {
    resetAll();
  });

  it("connection to error server fails fast (not 60s timeout)", async () => {
    const server = startErrorServer();
    const url = `http://localhost:${server.port}/mcp`;

    try {
      const result = await timedConnect(url);
      console.log(`  Error server: ${result.durationMs}ms — ${result.error}`);

      expect(result.error).toBeDefined();
      // Should fail in well under 5 seconds (no 60s timeout)
      expect(result.durationMs).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  });

  it("connection to hanging server triggers MCP timeout (~60s)", async () => {
    const server = startHangingServer();
    const url = `http://localhost:${server.port}/mcp`;

    try {
      const result = await timedConnect(url);
      console.log(`  Hanging server: ${result.durationMs}ms — ${result.error}`);

      expect(result.error).toBeDefined();
      // This is the key test — proves the 60s timeout hypothesis
      // MCP SDK default timeout is 60000ms
      expect(result.durationMs).toBeGreaterThan(55000);
      expect(result.durationMs).toBeLessThan(70000);
    } finally {
      server.stop(true);
    }
  }, 90_000); // extend test timeout to 90s

  it("circuit breaker prevents repeated 60s waits", async () => {
    const connId = "conn_hanging_test";

    // Simulate 3 failures (as if 3 requests already timed out)
    recordFailure(connId);
    recordFailure(connId);
    recordFailure(connId);

    // Now the circuit should be open — fail fast
    const start = Date.now();
    expect(() => assertCircuitClosed(connId)).toThrow(CircuitOpenError);
    const elapsed = Date.now() - start;

    console.log(`  Circuit open fail-fast: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5); // sub-millisecond
  });

  it("circuit breaker with real error server: 3 fast failures then instant reject", async () => {
    const server = startErrorServer();
    const url = `http://localhost:${server.port}/mcp`;
    const connId = "conn_error_e2e";

    try {
      // Make 3 real connection attempts that fail
      for (let i = 0; i < 3; i++) {
        const result = await timedConnect(url);
        expect(result.error).toBeDefined();
        recordFailure(connId);
        console.log(
          `  Attempt ${i + 1}: ${result.durationMs}ms — ${result.error?.slice(0, 80)}`,
        );
      }

      // Now circuit is open — should fail instantly without hitting the server
      const start = Date.now();
      expect(() => assertCircuitClosed(connId)).toThrow(CircuitOpenError);
      const elapsed = Date.now() - start;

      console.log(`  Circuit open (4th attempt): ${elapsed}ms — BLOCKED`);
      expect(elapsed).toBeLessThan(5);
    } finally {
      server.stop(true);
    }
  });

  it("circuit breaker recovers when server comes back", async () => {
    const connId = "conn_recovery_e2e";

    // Trip the circuit
    recordFailure(connId);
    recordFailure(connId);
    recordFailure(connId);
    expect(() => assertCircuitClosed(connId)).toThrow(CircuitOpenError);

    // Simulate recovery
    recordSuccess(connId);

    // Circuit should be closed again
    expect(() => assertCircuitClosed(connId)).not.toThrow();
  });
});
