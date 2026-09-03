/**
 * Reviewer-identity tokens: an HMAC over (task, reviewer, review cycle).
 *
 * The token is handed to a reviewer run in its prompt and echoed back to
 * `TASK_BOARD_REVIEW_DECISION`, which is how that tool knows the caller really
 * is the reviewer it says it is — without it `reviewer` is self-asserted and
 * one agent could forge the "both reviewers approved" auto-merge gate.
 *
 * A signature, not a stored row: the tuple it signs is already derivable at
 * verify time, so there is nothing to persist. Signed with `core/signing-key`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ReviewerKind } from "@decocms/shared/task-board";
import { getSigningKey } from "@/core/signing-key";

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

/** `reviewer` is the name the token was MINTED with, which for an in-flight run
 *  dispatched before the reviewers merged is `qa` / `code_review` — hence the
 *  wider type than {@link mintReviewToken}. */
export function verifyReviewToken(
  token: string,
  itemId: string,
  reviewer: ReviewerKind | "qa" | "code_review",
  cycleAt: Date,
): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(
    mintReviewToken(itemId, reviewer as ReviewerKind, cycleAt),
  );
  return a.length === b.length && timingSafeEqual(a, b);
}
