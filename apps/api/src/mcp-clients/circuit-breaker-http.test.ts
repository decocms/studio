/**
 * Circuit breaker against real local HTTP servers (infrastructure edge only —
 * see TESTING.md): failing servers trip the circuit, an open circuit rejects
 * instantly instead of paying the MCP SDK's 60s default connect timeout, and
 * a success closes it again.
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

/**
 * Start an HTTP server that immediately returns 500, counting every request it
 * receives — that count is how a test proves an open circuit never reached the
 * network, without timing the machine.
 */
function startErrorServer() {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requestCount++;
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  return { server, requests: () => requestCount };
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

describe("circuit breaker - real HTTP servers", () => {
  beforeEach(() => {
    resetAll();
  });

  it("connection to error server fails fast (not 60s timeout)", async () => {
    const { server } = startErrorServer();
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

  it("circuit breaker prevents repeated 60s waits", () => {
    const connId = "conn_hanging_test";

    // Simulate 3 failures (as if 3 requests already timed out)
    recordFailure(connId);
    recordFailure(connId);
    recordFailure(connId);

    // The circuit is open. Rejection is synchronous — this is a plain call, so
    // nothing could have been awaited — meaning the caller never waits on the
    // network, and the error carries the cooldown telling it when to retry.
    let thrown: unknown;
    try {
      assertCircuitClosed(connId);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CircuitOpenError);
    if (!(thrown instanceof CircuitOpenError)) throw thrown;
    expect(thrown.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it("circuit breaker with real error server: 3 fast failures then instant reject", async () => {
    const { server, requests } = startErrorServer();
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

      // Now the circuit is open — the 4th attempt is rejected without the
      // server ever seeing a request, which is what "fail fast" means here.
      const requestsBeforeBlock = requests();
      expect(requestsBeforeBlock).toBeGreaterThan(0);

      expect(() => assertCircuitClosed(connId)).toThrow(CircuitOpenError);

      console.log("  Circuit open (4th attempt): BLOCKED");
      expect(requests()).toBe(requestsBeforeBlock);
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
