/**
 * Relay sessions — cluster half of the chunk relay (protocol v2).
 *
 * One session per run, created by the first relay POST and pinned to this pod
 * (in-memory). The session owns a push-queue AsyncIterable feeding ONE
 * `consumeHarnessStream` invocation for the whole run; reconnect POSTs attach
 * to the same session and replayed lines (seq <= lastSeq) are dropped. Registry
 * loss (pod restart/crash) is terminal for the run: the daemon gets 410
 * relay_session_lost and stops; the idle reaper fails the run.
 *
 * The registry is deliberately kernel-agnostic — `deps.consume` is any
 * chunk-iterable consumer, so the dedupe/end/error semantics are unit-testable
 * with plain async functions (no StudioContext, no mocks).
 */
import type { UIMessageChunk } from "ai";
import type { RelayLine } from "@/links/protocol/relay";

export interface RelaySessionDeps {
  /**
   * The single consumer for this run's chunk stream. Invoked once at session
   * open; the returned promise becomes `whenComplete`. MUST consume the
   * iterable for the session to make progress.
   */
  consume: (chunks: AsyncIterable<UIMessageChunk>) => Promise<void>;
}

export interface RelaySession {
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
  /** Create the session for a run. Throws if one is already open. */
  open(runId: string, deps: RelaySessionDeps): RelaySession;
  get(runId: string): RelaySession | undefined;
}

class RelaySessionImpl implements RelaySession {
  lastSeq = 0;
  ended = false;
  readonly whenComplete: Promise<void>;

  private readonly queue: UIMessageChunk[] = [];
  private failure: (Error & { code?: string }) | null = null;
  private change = Promise.withResolvers<void>();

  constructor(deps: RelaySessionDeps) {
    // Flatten a synchronous throw from `consume` into a rejection so
    // `whenComplete` is the single settlement signal either way.
    this.whenComplete = (async () => await deps.consume(this.iterate()))();
  }

  push(line: RelayLine): void {
    if (line.seq <= this.lastSeq) return; // replayed prefix — already consumed
    this.lastSeq = line.seq;
    if (this.ended) return; // post-terminal line (e.g. done after error)
    const event = line.event;
    if (event.type === "ui-message-chunk") {
      this.queue.push(event.chunk as UIMessageChunk);
    } else if (event.type === "error") {
      this.ended = true;
      this.failure = Object.assign(
        new Error(`${event.code}: ${event.message}`),
        { code: event.code },
      );
    } else {
      // done
      this.ended = true;
    }
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

export function createRelaySessionRegistry(): RelaySessionRegistry {
  const sessions = new Map<string, RelaySessionImpl>();
  return {
    open(runId, deps) {
      if (sessions.has(runId)) {
        throw new Error(
          `[relay-session] run ${runId} already has an open relay session`,
        );
      }
      const session = new RelaySessionImpl(deps);
      sessions.set(runId, session);
      // Remove the entry once consume settles. The .catch both feeds the
      // .finally chain and marks `whenComplete` handled so an unawaited
      // rejection (daemon died before the terminal POST) never surfaces as an
      // unhandled rejection — route callers still observe the original
      // promise.
      void session.whenComplete
        .catch(() => {})
        .finally(() => {
          sessions.delete(runId);
        });
      return session;
    },
    get(runId) {
      return sessions.get(runId);
    },
  };
}
