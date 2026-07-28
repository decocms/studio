/**
 * Circuit Breaker for MCP Connections
 *
 * Prevents noisy-neighbor problems when downstream MCP servers are unreachable.
 * After repeated failures, the circuit opens and requests fail fast instead of
 * blocking for 60s (the MCP SDK initialization timeout) on every attempt.
 *
 * State machine: CLOSED → (failures ≥ threshold) → OPEN → (cooldown elapsed) → HALF_OPEN
 *   - HALF_OPEN + success → CLOSED
 *   - HALF_OPEN + failure → OPEN (cooldown resets)
 */

import {
  CIRCUIT_BREAKER_COOLDOWN_MS,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_HALF_OPEN_PROBE_TIMEOUT_MS,
  CIRCUIT_BREAKER_MAX_ENTRIES,
} from "../core/constants";
import { meter } from "../observability";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  halfOpenInFlight: boolean;
  halfOpenStartedAt: number;
}

const circuits = new Map<string, CircuitEntry>();

// Live circuit counts by state (sampled at scrape time). A rising `open` count
// means downstream MCP servers are unreachable and requests are failing fast —
// the signal an operator wants when proxied tools start erroring. O(n) over the
// map (n ≤ CIRCUIT_BREAKER_MAX_ENTRIES) per scrape.
meter
  .createObservableGauge("mcp_circuit_breaker.circuits", {
    description: "MCP connection circuits by state (open, half_open)",
    unit: "{circuits}",
  })
  .addCallback((r) => {
    let open = 0;
    let halfOpen = 0;
    for (const c of circuits.values()) {
      if (c.state === "OPEN") open++;
      else if (c.state === "HALF_OPEN") halfOpen++;
    }
    r.observe(open, { state: "open" });
    r.observe(halfOpen, { state: "half_open" });
  });

export class CircuitOpenError extends Error {
  readonly cooldownRemainingMs: number;
  constructor(connectionId: string, cooldownRemainingMs: number) {
    super(
      `Connection ${connectionId} circuit breaker is open — downstream server unreachable. ` +
        `Retry in ${Math.ceil(cooldownRemainingMs / 1000)}s.`,
    );
    this.name = "CircuitOpenError";
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

/**
 * Check if a request should proceed. Throws CircuitOpenError if circuit is open.
 * In HALF_OPEN state, allows exactly one probe request through.
 */
export function assertCircuitClosed(connectionId: string): void {
  const circuit = circuits.get(connectionId);
  if (!circuit || circuit.state === "CLOSED") return;

  if (circuit.state === "HALF_OPEN") {
    if (circuit.halfOpenInFlight) {
      const probeAge = Date.now() - circuit.halfOpenStartedAt;
      if (probeAge < CIRCUIT_BREAKER_HALF_OPEN_PROBE_TIMEOUT_MS) {
        throw new CircuitOpenError(connectionId, 0);
      }
      // The previous probe never reported an outcome (caller threw without
      // calling recordSuccess/recordFailure) — treat it as abandoned rather
      // than wedging the circuit open forever, and grant a fresh probe.
    }
    circuit.halfOpenInFlight = true;
    circuit.halfOpenStartedAt = Date.now();
    return;
  }

  // OPEN — check if cooldown has elapsed
  const elapsed = Date.now() - circuit.lastFailureTime;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    circuit.state = "HALF_OPEN";
    circuit.halfOpenInFlight = true;
    circuit.halfOpenStartedAt = Date.now();
    return;
  }

  throw new CircuitOpenError(
    connectionId,
    CIRCUIT_BREAKER_COOLDOWN_MS - elapsed,
  );
}

/**
 * Record a successful connection. Resets the circuit to CLOSED.
 */
export function recordSuccess(connectionId: string): void {
  circuits.delete(connectionId);
}

/**
 * Record a failed connection. Increments failures and opens circuit after threshold.
 */
export function recordFailure(connectionId: string): void {
  const circuit = circuits.get(connectionId);

  if (!circuit) {
    evictIfNeeded();
    circuits.set(connectionId, {
      state: 1 >= CIRCUIT_BREAKER_FAILURE_THRESHOLD ? "OPEN" : "CLOSED",
      consecutiveFailures: 1,
      lastFailureTime: Date.now(),
      halfOpenInFlight: false,
      halfOpenStartedAt: 0,
    });
    return;
  }

  circuit.consecutiveFailures++;
  circuit.lastFailureTime = Date.now();
  circuit.halfOpenInFlight = false;

  if (circuit.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    circuit.state = "OPEN";
  }
}

/**
 * Evict oldest entries when the map exceeds the max size.
 */
function evictIfNeeded(): void {
  if (circuits.size < CIRCUIT_BREAKER_MAX_ENTRIES) return;

  // Evict the entry with the oldest lastFailureTime
  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, entry] of circuits) {
    if (entry.lastFailureTime < oldestTime) {
      oldestTime = entry.lastFailureTime;
      oldestId = id;
    }
  }
  if (oldestId) circuits.delete(oldestId);
}

/**
 * Reset all circuit breakers. Exposed for testing only.
 */
export function resetAll(): void {
  circuits.clear();
}

/**
 * Get raw circuit entry for a connection. Exposed for testing only.
 * Allows tests to manipulate internal state (e.g., backdate lastFailureTime).
 */
export function _getCircuitForTest(connectionId: string) {
  return circuits.get(connectionId);
}
