import { z } from "zod";

/**
 * Everything an inbox row renders, copied onto the notification at write time
 * so the read touches exactly one table.
 *
 * The actor fields MUST be copies: `actor_id` is `on delete set null` and a
 * null actor already means "the agent did it" (what renders the agent glyph),
 * so without the copy a deleted member and the agent are indistinguishable.
 * A renamed task keeps its old title here, which is right — the row is the
 * record of an event, and its link goes to the live task via the immutable
 * `taskKeySeq`.
 */
export const NotificationDataSchema = z.object({
  taskTitle: z.string(),
  taskKeySeq: z.number().int().nullable(),
  actorName: z.string().nullable(),
  actorImage: z.string().nullable(),
});

export type NotificationData = z.infer<typeof NotificationDataSchema>;
