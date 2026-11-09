import { z } from "zod";

const url = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  });
const text = z.string().trim().min(1);
const messageSchema = z
  .object({
    version: z.literal(1).default(1),
    author: z
      .object({ name: text.max(200), avatarUrl: url.optional() })
      .strict(),
    body: text.max(24000),
    channel: text.max(200).optional(),
    url: url.optional(),
    sentAt: z.string().datetime({ offset: true }).optional(),
    attachments: z
      .array(
        z
          .object({
            name: text.max(200),
            url,
            kind: z.enum(["image", "video", "file"]).default("file"),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
const testingSchema = z
  .object({
    version: z.literal(1).default(1),
    title: text.max(200).optional(),
    previewUrl: url.optional(),
    pullRequest: z
      .object({ url, title: text.max(300).optional() })
      .strict()
      .optional(),
    note: text.max(2000).optional(),
    steps: z
      .array(
        z
          .object({
            action: text.max(2000),
            expected: text.max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export type MessageSource = "gchat" | "whatsapp" | "slack" | "email";
export type StructuredBlock =
  | {
      kind: "message";
      source: MessageSource;
      data: z.infer<typeof messageSchema>;
    }
  | { kind: "testing"; data: z.infer<typeof testingSchema> };

/** Invalid or incomplete streamed JSON remains an ordinary code block. */
export function parseStructuredBlock(
  language: string,
  content: string,
): StructuredBlock | null {
  if (content.length > 64000) return null;
  if (!["gchat", "whatsapp", "slack", "email", "testing"].includes(language))
    return null;
  try {
    const json: unknown = JSON.parse(content);
    if (language === "testing") {
      const parsed = testingSchema.safeParse(json);
      return parsed.success ? { kind: "testing", data: parsed.data } : null;
    }
    if (
      language === "gchat" ||
      language === "whatsapp" ||
      language === "slack" ||
      language === "email"
    ) {
      const parsed = messageSchema.safeParse(json);
      return parsed.success
        ? { kind: "message", source: language, data: parsed.data }
        : null;
    }
  } catch {
    /* Preserve the source for correction. */
  }
  return null;
}
