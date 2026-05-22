import z from "zod";

/**
 * Public-facing file config metadata. Access key and secret key are never
 * returned by any tool — the encrypted_credentials column is intentionally
 * omitted. Shared across all FILE_CONFIG_* tools so the wire contract can't
 * drift between them.
 */
export const fileConfigInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string().nullable(),
  forcePathStyle: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export type FileConfigInfoOutput = z.infer<typeof fileConfigInfoSchema>;

export const fileConfigNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/, {
    message:
      "Name may only contain letters, digits, underscore, dot, and hyphen.",
  });
