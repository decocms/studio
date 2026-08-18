/** Control-frame codec for cluster-to-daemon link commands. */
import { z } from "zod";

const controlFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel"), runId: z.string() }),
  z.object({ type: z.literal("cancel_req"), reqId: z.string() }),
  z.object({ type: z.literal("keep_alive") }),
  z.object({ type: z.literal("shutdown") }),
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;
