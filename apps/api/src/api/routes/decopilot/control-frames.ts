/** Control-frame codec for cluster-to-daemon link commands. */
import { z } from "zod";

const controlFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel"), runId: z.string() }),
  z.object({ type: z.literal("cancel_req"), reqId: z.string() }),
  z.object({ type: z.literal("keep_alive") }),
  z.object({ type: z.literal("shutdown") }),
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;

/** Serialize a control frame to a JSON string for tunnel delivery. */
export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/** Deserialize and validate a raw JSON string into a ControlFrame. Throws on invalid input. */
export function decodeControlFrame(raw: string): ControlFrame {
  return controlFrameSchema.parse(JSON.parse(raw));
}
