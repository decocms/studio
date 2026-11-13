import { z } from "zod";
import {
  FEEDBACK_KINDS,
  FEEDBACK_MAX_MESSAGE_CHARS,
} from "@decocms/shared/feedback";

export const FeedbackFields = z.object({
  // Clients from before Report a problem send no kind.
  kind: z.enum(FEEDBACK_KINDS).default("feedback"),
  message: z.string().trim().min(1).max(FEEDBACK_MAX_MESSAGE_CHARS),
  pageUrl: z
    .string()
    .max(4096)
    .url()
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    })
    .transform((value) => {
      const url = new URL(value);
      // Query strings and fragments can carry credentials or session state.
      return `${url.origin}${url.pathname}`;
    }),
});
