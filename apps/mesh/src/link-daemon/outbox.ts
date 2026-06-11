/**
 * Durable local outbox for the desktop→cluster uplink (spec §5.1, §13 step 2).
 *
 * A `bun:sqlite` (WAL) DB that every uplink event is appended to BEFORE the WS
 * send, keyed `(runId, fenceToken, wireSeq)` with `payload`, `lane`,
 * `createdAt`. This is the on-disk replacement for the in-memory `lines[]` +
 * 64 MiB cap in `chunk-relay.ts`: it survives daemon restart so a reconnect can
 * resend the unacked prefix.
 *
 * Step-2 scope (this file): schema + append-before-send + wireSeq-ordered
 * replay. Bounding (MAX_OUTBOX_BYTES) and terminal-only truncation live in
 * sibling tasks; the rolling ackSeq truncation arrives with the WS step (§13
 * step 4).
 *
 * No protocol change: `wireSeq` is today's relay `seq` and the stored `line` is
 * the exact `{ seq, event }` RelayLine that goes on the NDJSON wire. `lane` is
 * an internal column (Task: lane classifier), never serialized to the wire.
 */
import { Database } from "bun:sqlite";
import type { RelayLine } from "../links/protocol/relay";
import { relayLineSchema } from "../links/protocol/relay";
import type { OutboxLane } from "./outbox-lane";
import { assertBunRuntime } from "./outbox-runtime";

/**
 * Hard cap on the unacked outbox, per-run AND per-daemon (spec §5.1). On hit
 * the run fails loudly — the on-disk successor to today's in-memory
 * `RELAY_BUFFER_MAX_BYTES` 64 MiB loud-fail contract.
 */
export const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;

export interface OutboxAppend {
  runId: string;
  fenceToken: string;
  wireSeq: number;
  lane: OutboxLane;
  line: RelayLine;
}

export interface OutboxRow {
  runId: string;
  fenceToken: string;
  wireSeq: number;
  lane: OutboxLane;
  line: RelayLine;
  byteLength: number;
}

export interface OutboxReplayQuery {
  runId: string;
  fenceToken: string;
  fromSeq: number;
}

export interface OpenOutboxOptions {
  /** Filesystem path to the sqlite file (use ":memory:" only in throwaway tests). */
  path: string;
  /** Override the per-run/per-daemon byte cap (tests). Defaults to MAX_OUTBOX_BYTES. */
  maxBytes?: number;
}

interface OutboxDbRow {
  run_id: string;
  fence_token: string;
  wire_seq: number;
  lane: number;
  payload: string;
  byte_length: number;
}

const encoder = new TextEncoder();

export interface Outbox {
  append(row: OutboxAppend): void;
  replay(query: OutboxReplayQuery): OutboxRow[];
  /** Terminal-only truncation (§13 step 2): drop all rows for a fully-acked run. */
  truncateRun(scope: { runId: string; fenceToken: string }): void;
  /**
   * Rolling ackSeq truncation (§13 step 4): drop rows with wireSeq <= ackSeq for
   * one run, freeing the prefix the cluster has durably published. The unacked
   * tail (wireSeq > ackSeq) stays for resume.
   */
  truncateUpToSeq(scope: {
    runId: string;
    fenceToken: string;
    ackSeq: number;
  }): void;
  journalMode(): string;
  close(): void;
}

export function openOutbox(opts: OpenOutboxOptions): Outbox {
  assertBunRuntime();
  const db = new Database(opts.path, { create: true });
  // WAL: crash-safe, concurrent reader while the writer appends.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      run_id       TEXT    NOT NULL,
      fence_token  TEXT    NOT NULL,
      wire_seq     INTEGER NOT NULL,
      lane         INTEGER NOT NULL,
      payload      TEXT    NOT NULL,
      byte_length  INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (run_id, fence_token, wire_seq)
    )
  `);

  const insertStmt = db.query(
    `INSERT OR IGNORE INTO outbox
       (run_id, fence_token, wire_seq, lane, payload, byte_length, created_at)
     VALUES ($run, $fence, $seq, $lane, $payload, $bytes, $ts)`,
  );
  const replayStmt = db.query<OutboxDbRow, [string, string, number]>(
    `SELECT run_id, fence_token, wire_seq, lane, payload, byte_length
       FROM outbox
      WHERE run_id = ?1 AND fence_token = ?2 AND wire_seq >= ?3
      ORDER BY wire_seq ASC`,
  );

  const maxBytes = opts.maxBytes ?? MAX_OUTBOX_BYTES;
  const runSumStmt = db.query<{ total: number }, [string, string]>(
    `SELECT COALESCE(SUM(byte_length), 0) AS total
       FROM outbox WHERE run_id = ?1 AND fence_token = ?2`,
  );
  const daemonSumStmt = db.query<{ total: number }, []>(
    `SELECT COALESCE(SUM(byte_length), 0) AS total FROM outbox`,
  );
  const truncateStmt = db.query<unknown, [string, string]>(
    `DELETE FROM outbox WHERE run_id = ?1 AND fence_token = ?2`,
  );
  const truncateUpToStmt = db.query<unknown, [string, string, number]>(
    `DELETE FROM outbox WHERE run_id = ?1 AND fence_token = ?2 AND wire_seq <= ?3`,
  );

  return {
    append(row) {
      const payload = JSON.stringify(row.line);
      const byteLength = encoder.encode(payload).byteLength;
      const runTotal =
        runSumStmt.get(row.runId, row.fenceToken)!.total + byteLength;
      const daemonTotal = daemonSumStmt.get()!.total + byteLength;
      if (runTotal > maxBytes || daemonTotal > maxBytes) {
        throw new Error(
          `[outbox] runId=${row.runId}: outbox exceeded MAX_OUTBOX_BYTES ` +
            `(${maxBytes} bytes) at wireSeq ${row.wireSeq} ` +
            `(run=${runTotal}, daemon=${daemonTotal}) — failing the run ` +
            `instead of ballooning disk`,
        );
      }
      insertStmt.run({
        $run: row.runId,
        $fence: row.fenceToken,
        $seq: row.wireSeq,
        $lane: row.lane,
        $payload: payload,
        $bytes: byteLength,
        $ts: Date.now(),
      });
    },
    replay(query) {
      const rows = replayStmt.all(query.runId, query.fenceToken, query.fromSeq);
      return rows.map((r) => ({
        runId: r.run_id,
        fenceToken: r.fence_token,
        wireSeq: r.wire_seq,
        lane: r.lane as OutboxLane,
        line: relayLineSchema.parse(JSON.parse(r.payload)),
        byteLength: r.byte_length,
      }));
    },
    truncateRun(scope) {
      truncateStmt.run(scope.runId, scope.fenceToken);
    },
    truncateUpToSeq(scope) {
      truncateUpToStmt.run(scope.runId, scope.fenceToken, scope.ackSeq);
    },
    journalMode() {
      const row = db
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get();
      return row?.journal_mode ?? "";
    },
    close() {
      db.close();
    },
  };
}

/**
 * A non-durable Outbox backed by a `:memory:` sqlite DB. Same append/replay/cap/
 * truncate contract as {@link openOutbox}, but nothing survives `close()` (no
 * crash recovery). This is the relay's default when no durable outbox is
 * injected — production opens a file-backed outbox once per daemon and injects
 * it; tests and the transition path use this so a single code path drives both.
 */
export function openInMemoryOutbox(opts: { maxBytes?: number } = {}): Outbox {
  return openOutbox({ path: ":memory:", maxBytes: opts.maxBytes });
}
