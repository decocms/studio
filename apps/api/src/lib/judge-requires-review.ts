import { generateObject } from "ai";
import { z } from "zod";
import type { StudioContext } from "../core/studio-context";
import { resolveTier } from "../core/resolve-tier";
import {
  buildCommitContextSummary,
  type GitDiffLike,
  type GitStatusLike,
} from "./suggest-commit-message";

/** Whether a set of code changes needs human review before a direct publish. */
export interface ReviewVerdict {
  requiresReview: boolean;
  reason: string;
}

const ReviewVerdictSchema = z.object({
  requiresReview: z
    .boolean()
    .describe("true if the changes should go through pull-request review"),
  reason: z
    .string()
    .describe("One short sentence explaining the decision (max ~120 chars)"),
});

const REVIEW_JUDGE_SYSTEM = `You decide whether a set of changes to a web project must go through human pull-request review before being published directly to production.

Require review (requiresReview = true) when the changes:
- add or modify backend/server logic, API routes, or HTTP endpoints
- touch authentication, authorization, permissions, or security
- change the database, migrations, environment variables, or secrets
- add or change server-side integrations, jobs, or webhooks
- are large or sweeping: many files changed, or large/complex code edits
- look OBVIOUSLY broken or incomplete in the shown diff — e.g. a removed closing bracket/parenthesis/brace, an unterminated string or comment, a dangling/unbalanced expression, or a deletion that clearly leaves the code syntactically invalid. You only see diff snippets, not whole files, so flag this ONLY when the breakage is plainly visible in the changed lines; do NOT guess about code you can't see.

Do NOT require review (requiresReview = false) when the changes are low-risk, such as:
- frontend-only presentation: UI components, styling/CSS, layout, copy/text
- content or design edits
- small, localized, obviously-safe tweaks

When unsure between the two, lean toward NOT requiring review for small frontend-only diffs, and toward requiring it for anything backend or large.

Respond with the structured verdict and a short reason.`;

/**
 * Map a UI locale to a language name for the model. The `reason` is shown to
 * the user, so it should be written in their language. Unknown locales fall
 * back to English.
 */
function languageInstruction(language: string | undefined): string {
  switch (language) {
    case "pt-BR":
      return "Write the `reason` in Brazilian Portuguese (pt-BR).";
    default:
      return "Write the `reason` in English.";
  }
}

/**
 * Permissive fallback: when we can't run the judge (no org, no model provider,
 * or an error), do NOT block the user — allow the direct publish. This matches
 * the product decision that the AI's absence must never gate publishing.
 */
const ALLOW_FALLBACK: ReviewVerdict = { requiresReview: false, reason: "" };

/**
 * Ask the org's cheap "fast" model tier whether a publish payload needs review.
 * Mirrors `suggestCommitMessageWithLlm` (same tier + context-summary plumbing)
 * but returns a typed verdict via `generateObject`.
 */
export async function judgeRequiresReviewWithLlm(
  ctx: StudioContext,
  status: GitStatusLike,
  diff: GitDiffLike,
  language?: string,
): Promise<ReviewVerdict> {
  const orgId = ctx.organization?.id;
  if (!orgId) return ALLOW_FALLBACK;

  try {
    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, orgId);
    const model = provider.aiSdk.languageModel(tier.modelId);
    const summary = buildCommitContextSummary(status, diff);

    const { object } = await generateObject({
      model,
      schema: ReviewVerdictSchema,
      system: `${REVIEW_JUDGE_SYSTEM}\n\n${languageInstruction(language)}`,
      prompt: summary,
      temperature: 0,
    });

    return {
      requiresReview: object.requiresReview,
      reason: object.reason.trim().slice(0, 200),
    };
  } catch (err) {
    console.warn(
      "[judge-requires-review] LLM failed, allowing direct publish",
      err,
    );
    return ALLOW_FALLBACK;
  }
}
