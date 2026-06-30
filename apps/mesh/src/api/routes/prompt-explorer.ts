/**
 * Prompt Explorer Route
 *
 * Streams an AI-enriched version of a user's draft prompt. The frontend's
 * "Explore" modal POSTs a rough draft; a *fast* model rewrites it into a
 * richer, more complete prompt with [bracketed] fill-in placeholders, and the
 * result (plus any model reasoning) is streamed back as SSE frames.
 *
 * Route: POST /api/:org/prompt-explorer/stream
 *
 * Deliberately lightweight: it calls the `ai` SDK `streamText` directly (no
 * thread persistence / NATS / StreamBuffer). Mirrors the direct-streamText SSE
 * pattern in `openai-compat.ts`.
 */

import { streamText } from "ai";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { resolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import { buildPromptExplorerSystem } from "@/lib/prompt-explorer-system";

type Variables = { meshContext: StudioContext };

/** Cap to keep the model prompt (and our memory) bounded. */
const MAX_DRAFT_LENGTH = 20_000;

export const createPromptExplorerRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/prompt-explorer/stream", async (c) => {
    const ctx = c.get("meshContext");
    // Auth + org-membership are already enforced by `resolveOrgFromPath`
    // (mounted on every org-scoped route). This isn't a tool, so there's no
    // `toolName` for `ctx.access.check()` to authorize against — calling it
    // with no resources throws ForbiddenError. The userId/orgId guards below
    // mirror the sibling `thread-outputs` route.
    const userId = ctx.auth?.user?.id;
    if (!userId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      throw new HTTPException(400, { message: "Organization required" });
    }

    const body = await c.req
      .json<{ draft?: unknown }>()
      .catch(() => ({}) as { draft?: unknown });
    const draft =
      typeof body.draft === "string"
        ? body.draft.slice(0, MAX_DRAFT_LENGTH)
        : "";
    if (draft.trim().length === 0) {
      throw new HTTPException(400, { message: "draft is required" });
    }

    // Grow the prompt gradually each iteration: ~3x for short ideas, easing to
    // ~2x as it gets longer, so a one-liner doesn't balloon into a wall of
    // text. `maxChars` is the soft target (enforced via the system prompt);
    // `maxOutputTokens` is the hard ceiling so the model can't run away even if
    // it ignores the instruction.
    const sourceChars = draft.length;
    const factor = sourceChars < 300 ? 3 : sourceChars < 1000 ? 2.5 : 2;
    const maxChars = Math.round(sourceChars * factor);
    // ~3 chars/token (conservative → a little headroom over the target so the
    // model can finish its sentence rather than getting cut mid-word).
    const maxOutputTokens = Math.min(
      1200,
      Math.max(160, Math.ceil(maxChars / 3)),
    );

    const system = buildPromptExplorerSystem({
      userName: ctx.auth?.user?.name,
      userEmail: ctx.auth?.user?.email,
      orgName: ctx.organization?.name,
      maxChars,
    });

    return streamSSE(c, async (stream) => {
      try {
        const tier = await resolveTier(ctx, "fast");
        const provider = await ctx.aiProviders.activate(
          tier.credentialId,
          orgId,
        );
        const model = provider.aiSdk.languageModel(tier.modelId);

        const result = streamText({
          model,
          system,
          // Frame the draft as material to TRANSFORM, not a request to answer —
          // otherwise the model "helpfully" replies in the second person
          // ("Você quer…", "Describe…") instead of rewriting the user's prompt.
          prompt: `Below is the rough draft of MY prompt. Rewrite it as an improved version of MY prompt, in my own voice (same grammatical person and language as the draft). Output only the rewritten prompt.\n\n--- MY DRAFT ---\n${draft}`,
          maxOutputTokens,
          temperature: 0.4,
          abortSignal: c.req.raw.signal,
        });

        for await (const part of result.fullStream) {
          if (part.type === "reasoning-delta") {
            await stream.writeSSE({
              data: JSON.stringify({ type: "reasoning", text: part.text }),
            });
          } else if (part.type === "text-delta") {
            await stream.writeSSE({
              data: JSON.stringify({ type: "text", text: part.text }),
            });
          } else if (part.type === "error") {
            const message =
              part.error instanceof Error
                ? part.error.message
                : String(part.error);
            await stream.writeSSE({
              data: JSON.stringify({ type: "error", message }),
            });
          } else if (part.type === "finish") {
            // Stop as soon as the overall finish arrives rather than waiting
            // for the iterator to complete on its own, then close the stream.
            break;
          }
        }
        await stream.writeSSE({ data: JSON.stringify({ type: "finish" }) });
      } catch (err) {
        // Surface a friendly error frame (e.g. TierUnavailableError when the
        // org has no provider connected) rather than dropping the stream.
        const message =
          err instanceof Error ? err.message : "Failed to enrich prompt";
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message }),
        });
      }
    });
  });

  return app;
};
