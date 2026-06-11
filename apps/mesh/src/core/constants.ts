/**
 * Shared constants for MCP Mesh
 *
 * Constants used by both server-side and web code.
 */

/** MCP Mesh metadata key in tool _meta */
export const MCP_MESH_KEY = "mcp.mesh";

/**
 * Default timeout for MCP tool calls in milliseconds.
 * The MCP SDK default is 60 seconds (60000ms).
 * Increase this value for tools that take longer to execute.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Number of consecutive failures before opening the circuit breaker for a connection */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

/** Cooldown period in ms before allowing a probe request (half-open state) */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; // 30 seconds

/** Maximum number of circuit breaker entries to retain in memory */
export const CIRCUIT_BREAKER_MAX_ENTRIES = 1000;

/**
 * Number of times a connection's circuit may re-open before it is durably
 * disabled (connection.status → "error"). The in-memory breaker fast-fails for
 * a 30s cooldown and auto-recovers; if the downstream keeps failing across this
 * many open cycles, the connection is persisted as "error" so it stops paying a
 * handshake on every refresh across all pods, until manually re-enabled.
 */
export const CIRCUIT_BREAKER_DISABLE_AFTER_OPENS = 3;
/*
 * Durable connection auto-disable (cross-replica, via the shared circuit store).
 *
 * Distinct from the in-memory CIRCUIT_BREAKER_* guard above: that one fast-fails
 * per replica to bound latency on a hung server. These govern when a connection's
 * `status` is flipped to "error" so EVERY replica then stops probing a
 * persistently-failing downstream (fast-fail via the cheap DB status gate).
 */

/** Non-auth failures (aggregated across replicas) before a connection is durably disabled. */
export const CONNECTION_DISABLE_FAILURE_THRESHOLD = 5;

/**
 * Failures must be sustained at least this long before disabling. Filters out
 * transient blips / thundering herds that spike the count in well under a window.
 */
export const CONNECTION_DISABLE_MIN_WINDOW_MS = 60_000; // 60 seconds

/** TTL for shared failure-counter entries — a connection that stops failing self-resets. */
export const CONNECTION_CIRCUIT_TTL_MS = 5 * 60_000; // 5 minutes
