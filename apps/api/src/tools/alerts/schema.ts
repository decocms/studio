import { z } from "zod";

export const AlertSchema = z.object({
  id: z.string(),
  /** What raised it, e.g. `order_monitor`. */
  source: z.string(),
  /** What it is about: for `order_monitor`, the store's connection id. */
  subjectId: z.string(),
  rule: z.string(),
  title: z.string(),
  body: z.string(),
  /** Where to look, as a Studio path. */
  link: z.string().nullable(),
  createdAt: z.string(),
  ackedAt: z.string().nullable(),
  /** User id of whoever acked it, an agent acting for a user included. */
  ackedBy: z.string().nullable(),
  ackNote: z.string().nullable(),
  /** The task opened for it, when one was linked on ack. */
  taskBoardItemId: z.string().nullable(),
});
