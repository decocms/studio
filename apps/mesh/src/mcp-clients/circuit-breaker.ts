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
  CIRCUIT_BREAKER_DISABLE_AFTER_OPENS,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_MAX_ENTRIES,
} from "../core/constants";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  halfOpenInFlight: boolean;
  openCount: number;
}

export interface FailureOutcome {
  state: CircuitState;
  openCount: number;
  shouldDisable: boolean;
}

const circuits = new Map<string, CircuitEntry>();

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
      throw new CircuitOpenError(connectionId, 0);
    }
    circuit.halfOpenInFlight = true;
    return;
  }

  // OPEN — check if cooldown has elapsed
  const elapsed = Date.now() - circuit.lastFailureTime;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    circuit.state = "HALF_OPEN";
    circuit.halfOpenInFlight = true;
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
export function recordFailure(connectionId: string): FailureOutcome {
  let circuit = circuits.get(connectionId);

  if (!circuit) {
    evictIfNeeded();
    circuit = {
      state: "CLOSED",
      consecutiveFailures: 0,
      lastFailureTime: 0,
      halfOpenInFlight: false,
      openCount: 0,
    };
    circuits.set(connectionId, circuit);
  }

  const wasOpen = circuit.state === "OPEN";
  circuit.consecutiveFailures++;
  circuit.lastFailureTime = Date.now();
  circuit.halfOpenInFlight = false;

  if (
    circuit.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD &&
    !wasOpen
  ) {
    circuit.state = "OPEN";
    circuit.openCount++;
  }

  return {
    state: circuit.state,
    openCount: circuit.openCount,
    shouldDisable: circuit.openCount >= CIRCUIT_BREAKER_DISABLE_AFTER_OPENS,
  };
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
