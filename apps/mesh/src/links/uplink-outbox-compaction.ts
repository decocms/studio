/**
 * P2-only outbox compaction (spec §5.2). Under disk/credit pressure the daemon
 * coalesces adjacent P2 deltas; P0/P1 (control, tool, terminal) are NEVER
 * dropped or merged, and a P2 run is never collapsed across an intervening
 * P1/P0 chunk so ordering is preserved. The coalesced row keeps the HIGHEST
 * wireSeq so the rolling ackSeq cursor still advances over the merged range.
 */
import { type Lane, LANE_P2 } from "./protocol/uplink-frames";

export interface OutboxRow {
  wireSeq: number;
  lane: Lane;
  chunk: unknown;
}

type TextDelta = { type: string; id: string; delta: string };

function isMergeableTextDelta(c: unknown): c is TextDelta {
  return (
    typeof c === "object" &&
    c !== null &&
    ((c as { type?: unknown }).type === "text-delta" ||
      (c as { type?: unknown }).type === "reasoning-delta") &&
    typeof (c as { id?: unknown }).id === "string" &&
    typeof (c as { delta?: unknown }).delta === "string"
  );
}

export function compactP2(rows: OutboxRow[]): OutboxRow[] {
  const out: OutboxRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (
      row.lane === LANE_P2 &&
      prev?.lane === LANE_P2 &&
      isMergeableTextDelta(row.chunk) &&
      isMergeableTextDelta(prev.chunk) &&
      prev.chunk.type === row.chunk.type &&
      prev.chunk.id === row.chunk.id
    ) {
      // Merge into prev: concatenated delta, advance to the higher wireSeq.
      out[out.length - 1] = {
        wireSeq: row.wireSeq,
        lane: LANE_P2,
        chunk: { ...row.chunk, delta: prev.chunk.delta + row.chunk.delta },
      };
      continue;
    }
    out.push(row);
  }
  return out;
}
