import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { VOICE_SESSION_TTL_MS } from "@decocms/shared/voice";

const ClaimsSchema = z.object({
  sessionId: z.string().uuid(),
  organizationId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
  expiresAt: z.number().int().positive(),
});
export type VoiceClaims = z.infer<typeof ClaimsSchema>;

function signature(payload: string, secret: string) {
  if (!secret) throw new Error("Voice requires a shared authentication secret");
  return createHmac("sha256", secret)
    .update(`studio-voice-session:v1:${payload}`)
    .digest("base64url");
}

export function signVoiceGrant(claims: VoiceClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify(ClaimsSchema.parse(claims)),
  ).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyVoiceGrant(
  token: string,
  secret: string,
  now = Date.now(),
): VoiceClaims | null {
  if (!secret || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  if (!payload || !mac) return null;
  const expected = Buffer.from(signature(payload, secret));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  try {
    const result = ClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    if (
      !result.success ||
      result.data.expiresAt <= now ||
      result.data.expiresAt > now + VOICE_SESSION_TTL_MS
    )
      return null;
    return result.data;
  } catch {
    return null;
  }
}
