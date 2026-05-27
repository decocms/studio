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
  prefix: z.string().nullable(),
  publicUrlBase: z.string().nullable(),
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

/**
 * Normalize a key prefix so consumers can safely concatenate `prefix + key`:
 * trim whitespace, drop any leading slash, and ensure a single trailing slash
 * when non-empty. Returns null when the input is empty/undefined.
 */
export function normalizePrefix(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  const trimmed = input.trim().replace(/^\/+/, "");
  if (trimmed === "") return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Normalize a public URL base so callers can safely concatenate
 * `publicUrlBase + key`: trim whitespace and strip trailing slashes. Returns
 * null when the input is empty/undefined.
 */
export function normalizePublicUrlBase(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  const trimmed = input.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}
