/**
 * Reviewer-identity tokens: an HMAC over (task, reviewer, review cycle).
 *
 * The token is handed to a reviewer run in its prompt and echoed back to
 * `TASK_BOARD_REVIEW_DECISION`, which is how that tool knows the caller really
 * is the reviewer it says it is — without it `reviewer` is self-asserted and
 * one agent could forge the "both reviewers approved" auto-merge gate.
 *
 * A signature, not a stored row: the tuple it signs is already derivable at
 * verify time, so there is nothing to persist. Same signing key and compare as
 * `file-storage/share-password.ts`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ReviewerKind } from "@decocms/shared/task-board";
import { getSettings } from "@/settings";

let signingKey: Buffer | null = null;
function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  let secret: string | undefined;
  try {
    const settings = getSettings();
    secret = settings.studioJwtSecret ?? settings.betterAuthSecret;
  } catch {
    // Settings not initialized (e.g. unit tests) — fall back like auth/jwt.ts.
    secret = undefined;
  }
  signingKey = secret ? Buffer.from(secret) : randomBytes(32);
  return signingKey;
}

/** The `rtok_` prefix is quoted verbatim in reviewer prompts — keep it. */
export function mintReviewToken(
  itemId: string,
  reviewer: ReviewerKind,
  cycleAt: Date,
): string {
  const mac = createHmac("sha256", getSigningKey())
    .update(`${itemId}:${reviewer}:${cycleAt.toISOString()}`)
    .digest("base64url");
  return `rtok_${mac}`;
}

export function verifyReviewToken(
  token: string,
  itemId: string,
  reviewer: ReviewerKind,
  cycleAt: Date,
): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(mintReviewToken(itemId, reviewer, cycleAt));
  return a.length === b.length && timingSafeEqual(a, b);
}
