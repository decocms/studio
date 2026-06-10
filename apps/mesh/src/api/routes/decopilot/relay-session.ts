/**
 * Relay sessions — cluster half of the chunk relay (protocol v2).
 *
 * One session per run, created by the first relay POST and pinned to this pod
 * (in-memory). The session owns a push-queue AsyncIterable feeding ONE
 * `consumeHarnessStream` invocation for the whole run; reconnect POSTs attach
 * to the same session and replayed lines (seq <= lastSeq) are dropped.
 *
 * Fence epochs: a session is keyed by `runId` (== threadId today) AND carries
 * the fence token it was opened with. Because `runId == threadId`, a daemon
 * that dies mid-run leaves a parked session keyed by that runId; the NEXT run
 * on the same thread mints a FRESH fence (see dispatch-run's `prepareRun`) and
 * relays from seq 1. Attaching by runId alone would splice those fresh lines
 * into the stale kernel. The route therefore attaches only when the presented
 * fence equals the session's fence; a fence mismatch evicts the stale session
 * and opens a new one (the presented fence is already validated against the DB
 * by `validateRunAccess`, so presented==DB-current is sound to attach by).
 *
 * Registry loss (pod restart/crash) is recoverable, NOT terminal: the shipped
 * daemon always posts `x-relay-from: 1`, so a fresh session re-consumes the
 * full prefix from seq 1 — parts are id-deduped and the completed transition
 * is guarded, so the redelivery is idempotent. The `410 relay_session_lost`
 * branch in the route is reserved for a future mid-stream resume (`x-relay-from
 * > 1`) and is currently unreachable from the shipped daemon. A reconnect
 * landing on ANOTHER pod opens a concurrent fresh session there; the same
 * dedupe/guard make that safe (live-edge chunks may duplicate and the completed
 * event may double-fire — acceptable, documented).
 *
 * The registry is deliberately kernel-agnostic — `deps.consume` is any
 * chunk-iterable consumer, so the dedupe/end/error/evict semantics are
 * unit-testable with plain async functions (no StudioContext, no mocks).
 */
import type { UIMessageChunk } from "ai";
import type { RelayLine } from "@/links/protocol/relay";

/**
 * Idle reaper window: a session that receives no `push()` for this long is
 * abandoned (daemon death without an error line, mid-body 400 after open) and
 * is evicted — failing its iterable so the kernel's onError path runs the
 * durable-failure cleanup. Exported so tests can read the default; the registry
 * accepts an override so tests use a tiny timeout (no real long sleeps).
 */
export const RELAY_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Why a session was evicted. Drives whether eviction has a status side-effect:
 * - `relay_superseded`: a FRESH run is taking over the same threadId/runId. The
 *   same run row is about to be re-driven by the new session, so eviction must
 *   NOT write `failed` — doing so would race the new session's guarded
 *   completion. Eviction only tears down the in-memory iterable + timers.
 * - `relay_idle_timeout`: the run is genuinely abandoned and no fresh run is
 *   taking over. Marking it failed is appropriate; the kernel's onError path
 *   (driven by the failed iterable) performs the durable status write.
 */
export type RelayEvictReason = "relay_superseded" | "relay_idle_timeout";

export interface RelaySessionDeps {
  /**
   * The single consumer for this run's chunk stream. Invoked once at session
   * open; the returned promise becomes `whenComplete`. MUST consume the
   * iterable for the session to make progress.
   */
  consume: (chunks: AsyncIterable<UIMessageChunk>) => Promise<void>;
}

export interface RelaySession {
  /** The fence token this session was opened with — its epoch identity. */
  readonly fenceToken: string | null;
  /**
   * Feed one relay line into the session. Dedupe: lines with
   * `seq <= lastSeq` are dropped (the daemon resends the full prefix on
   * reconnect). `ui-message-chunk` enqueues the chunk; `error` terminates the
   * iterable by rejecting with an Error carrying `code` + message; `done`
   * ends the iterable. Lines after the terminal still bump `lastSeq` (the
   * daemon's ack check needs the terminal seq) but deliver nothing.
   */
  push(line: RelayLine): void;
  /** Highest seq accepted so far — echoed back in the POST ack. */
  readonly lastSeq: number;
  /** True once a terminal line (`done` or `error`) has been pushed. */
  readonly ended: boolean;
  /** Settles when `deps.consume` settles (rejects if it rejects). */
  readonly whenComplete: Promise<void>;
}

export interface RelaySessionRegistry {
  /**
   * Create the session for a run, tagged with the fence token it relays for.
   * Throws if one is already open for this runId — callers evict the stale
   * session first on a fence mismatch.
   */
  open(
    runId: string,
    fenceToken: string | null,
    deps: RelaySessionDeps,
  ): RelaySession;
  get(runId: string): RelaySession | undefined;
  /**
   * Terminate the in-memory session for a run: fail its iterable with an Error
   * carrying `code === reason`, clear its idle timer, and remove the registry
   * entry. The failed iterable settles `consume()` (its onError path runs).
   * For `relay_superseded` the onError MUST NOT write a durable failed status
   * (the same run is re-driven by a fresh session); for `relay_idle_timeout`
   * it should. That decision lives in the consume() impl, keyed off the error
   * code — see `consumeRelayedRun` in link-ingest-routes.ts. No-op for an
   * unknown runId.
   */
  evict(runId: string, reason: RelayEvictReason): void;
}

class RelaySessionImpl implements RelaySession {
  lastSeq = 0;
  ended = false;
  readonly whenComplete: Promise<void>;

  private readonly queue: UIMessageChunk[] = [];
  private failure: (Error & { code?: string }) | null = null;
  private change = Promise.withResolvers<void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly fenceToken: string | null,
    deps: RelaySessionDeps,
    private readonly idleTimeoutMs: number,
    private readonly onIdle: () => void,
  ) {
    // Flatten a synchronous throw from `consume` into a rejection so
    // `whenComplete` is the single settlement signal either way.
    this.whenComplete = (async () => await deps.consume(this.iterate()))();
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.ended || this.failure) return;
    this.clearIdleTimer();
    const timer = setTimeout(this.onIdle, this.idleTimeoutMs);
    // Never let the reaper timer keep the process alive (matches daemon-side
    // backoff timers). `unref` is Node/Bun-only; guard for portability.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  push(line: RelayLine): void {
    if (line.seq <= this.lastSeq) return; // replayed prefix — already consumed
    this.lastSeq = line.seq;
    if (this.ended) return; // post-terminal line (e.g. done after error)
    // Liveness: a real push resets the idle reaper window.
    this.armIdleTimer();
    const event = line.event;
    if (event.type === "ui-message-chunk") {
      this.queue.push(event.chunk as UIMessageChunk);
    } else if (event.type === "error") {
      this.ended = true;
      this.clearIdleTimer();
      this.failure = Object.assign(
        new Error(`${event.code}: ${event.message}`),
        { code: event.code },
      );
    } else {
      // done
      this.ended = true;
      this.clearIdleTimer();
    }
    this.signalChange();
  }

  /**
   * Terminate the session's iterable with a coded failure (eviction). A no-op
   * once the session has already ended/failed — a terminal line always wins
   * over an eviction race.
   */
  fail(reason: RelayEvictReason): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    this.clearIdleTimer();
    this.failure = Object.assign(new Error(reason), { code: reason });
    this.signalChange();
  }

  private signalChange(): void {
    const prev = this.change;
    this.change = Promise.withResolvers<void>();
    prev.resolve();
  }

  private async *iterate(): AsyncGenerator<UIMessageChunk, void, undefined> {
    while (true) {
      // Capture the waiter BEFORE checking state: any push after the checks
      // resolves this captured promise (no lost wakeups) — same idiom as the
      // daemon relay's signalChange (chunk-relay.ts).
      const waiter = this.change.promise;
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      // Queued chunks drain before a failure surfaces: an error line only
      // terminates the stream after everything relayed before it.
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await waiter;
    }
  }
}

export interface RelaySessionRegistryOptions {
  /** Idle reaper window override (tests). Defaults to
   *  `RELAY_SESSION_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
}

export function createRelaySessionRegistry(
  options: RelaySessionRegistryOptions = {},
): RelaySessionRegistry {
  const idleTimeoutMs = options.idleTimeoutMs ?? RELAY_SESSION_IDLE_TIMEOUT_MS;
  const sessions = new Map<string, RelaySessionImpl>();
  const registry: RelaySessionRegistry = {
    open(runId, fenceToken, deps) {
      if (sessions.has(runId)) {
        throw new Error(
          `[relay-session] run ${runId} already has an open relay session`,
        );
      }
      const session = new RelaySessionImpl(
        fenceToken,
        deps,
        idleTimeoutMs,
        () => registry.evict(runId, "relay_idle_timeout"),
      );
      sessions.set(runId, session);
      // Remove the entry once consume settles. The .catch both feeds the
      // .finally chain and marks `whenComplete` handled so an unawaited
      // rejection (daemon died before the terminal POST) never surfaces as an
      // unhandled rejection — route callers still observe the original
      // promise. Guard the delete: an eviction may have already replaced this
      // entry with a fresh session for the same runId (fence supersede), so
      // only remove our own entry.
      void session.whenComplete
        .catch(() => {})
        .finally(() => {
          if (sessions.get(runId) === session) sessions.delete(runId);
        });
      return session;
    },
    get(runId) {
      return sessions.get(runId);
    },
    evict(runId, reason) {
      const session = sessions.get(runId);
      if (!session) return;
      // Remove BEFORE failing so a fresh open() for the same runId (supersede)
      // doesn't trip the "already open" guard, and the settle .finally above
      // won't delete the replacement entry.
      sessions.delete(runId);
      session.fail(reason);
    },
  };
  return registry;
}
