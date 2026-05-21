import z from "zod";

/**
 * Public-facing secret metadata. Values are never returned by any tool — the
 * encrypted_value column is intentionally omitted. Shared across SECRET_CREATE
 * and SECRET_LIST so the wire contract can't drift between them.
 */
export const secretInfoSchema = z.object({
  id: z.string(),
  scope: z.enum(["user", "organization"]),
  userId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export type SecretInfoOutput = z.infer<typeof secretInfoSchema>;
