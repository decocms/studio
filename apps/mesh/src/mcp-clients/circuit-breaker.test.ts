import { describe, expect, it, beforeEach } from "bun:test";
import {
  assertCircuitClosed,
  CircuitOpenError,
  recordFailure,
  recordSuccess,
  resetAll,
  _getCircuitForTest,
} from "./circuit-breaker";

// Use a fresh state for each test
beforeEach(() => {
  resetAll();
});

describe("circuit-breaker", () => {
  it("allows requests for unknown connections (CLOSED by default)", () => {
    expect(() => assertCircuitClosed("conn_new")).not.toThrow();
  });

  it("stays CLOSED below failure threshold", () => {
    recordFailure("conn_a");
    recordFailure("conn_a");
    // 2 failures, threshold is 3
    expect(() => assertCircuitClosed("conn_a")).not.toThrow();
  });

  it("opens after reaching failure threshold", () => {
    recordFailure("conn_a");
    recordFailure("conn_a");
    recordFailure("conn_a");
    expect(() => assertCircuitClosed("conn_a")).toThrow(CircuitOpenError);
  });

  it("fail-fast while OPEN (no blocking)", () => {
    for (let i = 0; i < 3; i++) recordFailure("conn_a");

    const start = Date.now();
    expect(() => assertCircuitClosed("conn_a")).toThrow(CircuitOpenError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10); // should be instant
  });

  it("success resets failure count", () => {
    recordFailure("conn_a");
    recordFailure("conn_a");
    recordSuccess("conn_a");
    recordFailure("conn_a");
    recordFailure("conn_a");
    // 2 failures after reset, below threshold
    expect(() => assertCircuitClosed("conn_a")).not.toThrow();
  });

  it("transitions to HALF_OPEN after cooldown and allows one probe", () => {
    for (let i = 0; i < 3; i++) recordFailure("conn_a");
    expect(() => assertCircuitClosed("conn_a")).toThrow(CircuitOpenError);

    // Backdate lastFailureTime to simulate cooldown elapsed
    const circuit = _getCircuitForTest("conn_a");
    expect(circuit).toBeDefined();
    circuit!.lastFailureTime = Date.now() - 60_000;

    // Should now transition to HALF_OPEN and allow one probe
    expect(() => assertCircuitClosed("conn_a")).not.toThrow();
    expect(circuit!.state).toBe("HALF_OPEN");

    // Second concurrent request while probing should be blocked
    expect(() => assertCircuitClosed("conn_a")).toThrow(CircuitOpenError);
  });

  it("isolates circuits per connection", () => {
    for (let i = 0; i < 3; i++) recordFailure("conn_a");

    expect(() => assertCircuitClosed("conn_a")).toThrow(CircuitOpenError);
    expect(() => assertCircuitClosed("conn_b")).not.toThrow();
  });

  it("probe failure re-opens the circuit", () => {
    for (let i = 0; i < 3; i++) recordFailure("conn_a");
    // Circuit is OPEN; recording another failure keeps it open
    recordFailure("conn_a");
    expect(() => assertCircuitClosed("conn_a")).toThrow(CircuitOpenError);
  });

  it("reports openCount and does not signal disable on the first open", () => {
    const r1 = recordFailure("conn_a");
    expect(r1.shouldDisable).toBe(false);
    const r2 = recordFailure("conn_a");
    expect(r2.shouldDisable).toBe(false);
    // Third failure crosses the failure threshold → first OPEN cycle.
    const r3 = recordFailure("conn_a");
    expect(r3.state).toBe("OPEN");
    expect(r3.openCount).toBe(1);
    expect(r3.shouldDisable).toBe(false);
  });

  it("signals disable after re-opening across cooldown cycles", () => {
    // First open cycle.
    for (let i = 0; i < 3; i++) recordFailure("conn_a");
    expect(_getCircuitForTest("conn_a")!.openCount).toBe(1);

    // Each cooldown→HALF_OPEN→failed-probe re-opens the circuit once.
    const reopen = () => {
      const circuit = _getCircuitForTest("conn_a")!;
      circuit.lastFailureTime = Date.now() - 60_000;
      assertCircuitClosed("conn_a"); // → HALF_OPEN, probe allowed
      return recordFailure("conn_a"); // probe fails → OPEN again
    };

    const second = reopen();
    expect(second.openCount).toBe(2);
    expect(second.shouldDisable).toBe(false);

    const third = reopen();
    expect(third.openCount).toBe(3);
    expect(third.shouldDisable).toBe(true);
  });

  it("success clears the open-cycle counter", () => {
    for (let i = 0; i < 3; i++) recordFailure("conn_a");
    recordSuccess("conn_a");
    // Counter resets — a fresh failure burst starts the cycle count over.
    const r = recordFailure("conn_a");
    expect(r.openCount).toBe(0);
    expect(r.shouldDisable).toBe(false);
  });

  it("includes retry info in error message", () => {
    for (let i = 0; i < 3; i++) recordFailure("conn_a");
    let thrown: unknown;
    try {
      assertCircuitClosed("conn_a");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CircuitOpenError);
    expect((thrown as Error).message).toContain("conn_a");
    expect((thrown as Error).message).toContain("circuit breaker is open");
    expect((thrown as Error).message).toContain("Retry in");
  });
});
