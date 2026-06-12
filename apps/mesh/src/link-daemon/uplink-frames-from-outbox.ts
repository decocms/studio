/**
 * Convert durable outbox rows to WS uplink chunk frames (pure, no I/O). The
 * daemon-side WS sender replays `outbox.replay(fromSeq)` and maps each row to a
 * chunk frame: the lane is already computed + stored on the row, and the raw
 * UIMessageChunk is the relay line's event (the daemon never folds — §6).
 */
import type { ChunkFrame, Lane } from "../links/protocol/uplink-frames";
import type { OutboxRow } from "./outbox";

export function outboxRowsToChunkFrames(rows: OutboxRow[]): ChunkFrame[] {
  return rows.map((row) => ({
    type: "chunk" as const,
    runId: row.runId,
    fenceToken: row.fenceToken,
    wireSeq: row.wireSeq,
    lane: row.lane as Lane,
    chunk: row.line.event,
  }));
}
