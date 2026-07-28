/**
 * Shared constants for Studio
 *
 * Constants used by both server-side and web code.
 */

/**
 * Default timeout for MCP tool calls in milliseconds.
 * The MCP SDK default is 60 seconds (60000ms).
 * Increase this value for tools that take longer to execute.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Timeout for the live `listTools()` probe used when filtering a connection
 * collection by binding (e.g. the Automations event-trigger picker, which lists
 * every TRIGGER-capable connection). The probe eagerly connects to the
 * downstream MCP server, so without a bound a single slow/hung connection
 * stalls the whole fan-out and the UI hangs until the SDK's 60s default fires.
 */
export const MCP_LIST_TOOLS_TIMEOUT_MS = 5_000; // 5 seconds

/** Number of consecutive failures before opening the circuit breaker for a connection */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

/** Cooldown period in ms before allowing a probe request (half-open state) */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; // 30 seconds

/**
 * Max age of an in-flight half-open probe before it's considered abandoned.
 * A caller can grant itself the probe via assertCircuitClosed() and then throw
 * before calling recordSuccess/recordFailure (e.g. a caller path that
 * deliberately skips both, like an auth-recoverable error). Without this
 * bound, that circuit would fail-fast forever since no future request could
 * ever win the single-probe slot. Set above the MCP SDK's 60s connect
 * timeout so a genuinely slow (not abandoned) probe isn't preempted.
 */
export const CIRCUIT_BREAKER_HALF_OPEN_PROBE_TIMEOUT_MS = 65_000; // 65 seconds

/** Maximum number of circuit breaker entries to retain in memory */
export const CIRCUIT_BREAKER_MAX_ENTRIES = 1000;

/**
 * Consecutive credential-decryption failures (per replica) before a connection
 * is durably disabled (status="error"). A decrypt failure is deterministic — the
 * same key never recovers — so a small buffer is enough; it only guards against a
 * transient key-load race at boot. Mirrors CIRCUIT_BREAKER_FAILURE_THRESHOLD.
 */
export const CONNECTION_DECRYPT_DISABLE_THRESHOLD = 3;

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

/**
 * Cooldown before an auto-disabled (status="error") connection is re-probed.
 * After this window a single request triggers a half-open handshake; success
 * re-activates the connection, failure restarts the window. Manual "inactive"
 * disables never auto-recover.
 */
export const CONNECTION_ERROR_REPROBE_COOLDOWN_MS = 60_000; // 60 seconds
