import z from "zod";

const token = z
  .string()
  .min(1)
  .max(32768)
  .refine((s) => !/\s/.test(s));
const authSchema = z.object({
  auth_mode: z.literal("chatgpt").optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    access_token: token,
    refresh_token: token,
    id_token: token,
    account_id: z.string().min(1).max(512),
  }),
  last_refresh: z.string().datetime({ offset: true }).optional(),
});

/** Strip unrelated cache fields and reject API-key logins before encryption. */
export function normalizeCodexAuth(pasted: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(pasted);
  } catch {
    throw new Error("Paste the auth.json file created by `codex login`.");
  }
  const parsed = authSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Use a ChatGPT login from `codex login`, with refreshable subscription credentials. API keys are not accepted here.",
    );
  return JSON.stringify(parsed.data);
}
