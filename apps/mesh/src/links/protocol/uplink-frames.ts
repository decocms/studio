/**
 * WebSocket uplink frame protocol (transport-layer spec §5.2).
 *
 * The return-leg WS replaces the NDJSON POST relay. Frames are JSON, one per
 * WS message. `chunk.chunk` is an opaque raw UIMessageChunk — the daemon does
 * NOT fold (§6); the cluster DB-writer consumer is the sole reassembler.
 *
 * Lanes (priority): P0 control, P1 tool+terminal (never dropped), P2 deltas
 * (may compact under pressure), P3 reserved (sender never emits in phase 1;
 * the receiver hard-rejects a chunk on it — see ingest).
 */
import { z } from "zod";

export const LANE_P0 = 0 as const;
export const LANE_P1 = 1 as const;
export const LANE_P2 = 2 as const;
export const LANE_P3 = 3 as const;
const laneSchema = z.union([
  z.literal(LANE_P0),
  z.literal(LANE_P1),
  z.literal(LANE_P2),
  z.literal(LANE_P3),
]);
export type Lane = z.infer<typeof laneSchema>;

/**
 * Shallow `chunk.type` tag-switch → lane (§5.2). NOT folding: only `type` is
 * read. P2 = compactable deltas; everything else (tool I/O, lifecycle,
 * terminal, AND any unknown type) → P1 so it is never dropped. P0/P3 are
 * never produced from a chunk type (P0 is control frames; P3 is reserved).
 */
export function laneForChunkType(type: string): Lane {
  if (
    type === "text-delta" ||
    type === "reasoning-delta" ||
    type.startsWith("data-")
  ) {
    return LANE_P2;
  }
  return LANE_P1;
}

const helloFrameSchema = z.object({
  type: z.literal("hello"),
  machineId: z.string(),
  protocol: z.number().int().positive(),
  bearer: z.string().optional(),
});

const resumeFrameSchema = z.object({
  type: z.literal("resume"),
  runId: z.string(),
  fenceToken: z.string(),
  fromSeq: z.number().int().positive(),
});

const chunkFrameSchema = z.object({
  type: z.literal("chunk"),
  runId: z.string(),
  fenceToken: z.string(),
  wireSeq: z.number().int().positive(),
  lane: laneSchema,
  chunk: z.unknown(),
});

const acceptFrameSchema = z.object({
  type: z.literal("accept"),
  runId: z.string(),
  fenceToken: z.string(),
  ackSeq: z.number().int().nonnegative(),
  cancelled: z.boolean(),
});

const ackFrameSchema = z.object({
  type: z.literal("ack"),
  runId: z.string(),
  fenceToken: z.string(),
  ackSeq: z.number().int().nonnegative(),
});

const cancelFrameSchema = z.object({
  type: z.literal("cancel"),
  runId: z.string(),
  fenceToken: z.string(),
});

const flowFrameSchema = z.object({
  type: z.literal("flow"),
  lane: laneSchema,
  maxInFlightBytes: z.number().int().nonnegative(),
});

export const uplinkFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  resumeFrameSchema,
  chunkFrameSchema,
  acceptFrameSchema,
  ackFrameSchema,
  cancelFrameSchema,
  flowFrameSchema,
]);
export type UplinkFrame = z.infer<typeof uplinkFrameSchema>;
export type ChunkFrame = z.infer<typeof chunkFrameSchema>;
export type AcceptFrame = z.infer<typeof acceptFrameSchema>;
