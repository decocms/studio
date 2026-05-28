/**
 * Frame protocol for the daemon ↔ mesh-pod WebSocket. Frames are JSON
 * text-frames over a single WS, multiplexed by `reqId`. The `hello` frame is
 * the only one without a reqId — it's the one-shot handshake.
 */
import { z } from "zod";

const helloFrame = z.object({
  type: z.literal("hello"),
  previewPort: z.number().int().min(1).max(65535),
  machineId: z.string().min(1),
  hostname: z.string().optional(),
  cliVersion: z.string().min(1),
  capabilities: z.array(z.string()),
});

const requestFrame = z.object({
  type: z.literal("request"),
  reqId: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});

const cancelFrame = z.object({
  type: z.literal("cancel"),
  reqId: z.string().min(1),
});

const headersFrame = z.object({
  type: z.literal("headers"),
  reqId: z.string().min(1),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
});

const chunkFrame = z.object({
  type: z.literal("chunk"),
  reqId: z.string().min(1),
  data: z.string(),
});

const endFrame = z.object({
  type: z.literal("end"),
  reqId: z.string().min(1),
});

const errorFrame = z.object({
  type: z.literal("error"),
  reqId: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
});

export const dispatchFrameSchema = z.discriminatedUnion("type", [
  helloFrame,
  requestFrame,
  cancelFrame,
  headersFrame,
  chunkFrame,
  endFrame,
  errorFrame,
]);

export type HelloFrame = z.infer<typeof helloFrame>;
export type RequestFrame = z.infer<typeof requestFrame>;
export type CancelFrame = z.infer<typeof cancelFrame>;
export type HeadersFrame = z.infer<typeof headersFrame>;
export type ChunkFrame = z.infer<typeof chunkFrame>;
export type EndFrame = z.infer<typeof endFrame>;
export type ErrorFrame = z.infer<typeof errorFrame>;
export type DispatchFrame = z.infer<typeof dispatchFrameSchema>;

export function encodeFrame(frame: DispatchFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(text: string): DispatchFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("dispatch-frames: malformed JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("dispatch-frames: frame must be an object");
  }
  const type = (raw as { type?: unknown }).type;
  if (
    typeof type !== "string" ||
    ![
      "hello",
      "request",
      "cancel",
      "headers",
      "chunk",
      "end",
      "error",
    ].includes(type)
  ) {
    throw new Error(`dispatch-frames: unknown frame type "${String(type)}"`);
  }
  const parsed = dispatchFrameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`dispatch-frames: ${parsed.error.message}`);
  }
  return parsed.data;
}
