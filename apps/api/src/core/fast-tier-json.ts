/**
 * One JSON answer from an organization's "fast" model tier, for background
 * judgement calls (duplicate checks, repository briefs) that must degrade
 * quietly when the org has no provider or the model misbehaves.
 */

import { generateText } from "ai";
import type { z } from "zod";
import { resolveTier } from "./resolve-tier";
import type { StudioContext } from "./studio-context";

/**
 * The JSON object a model was asked for, out of whatever it actually wrote:
 * bare, fenced, or wrapped in a sentence. Null when nothing parses or the
 * shape is wrong.
 */
export function parseModelJson<T>(
  text: string,
  schema: z.ZodType<T>,
): T | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  for (const candidate of balancedObjects(cleaned)) {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON at this brace; try the next object.
    }
  }
  return null;
}

/** Every top-level `{…}` span in `text`, last first: a reasoning model tends to
 *  narrate, sometimes with braces, before writing the answer it was asked for. */
function balancedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) spans.push(text.slice(start, i + 1));
    }
  }
  return spans.reverse();
}

/**
 * One JSON-answer call to the org's "fast" tier. Plain `generateText` with the
 * schema described in the prompt, not `generateObject`: the fast slot is
 * whatever cheap model the org's provider offers, and native structured-output
 * mode is not something every one of them supports through every gateway.
 *
 * Resolves to the parsed answer, or to a `skipped` reason when there is no
 * provider, the call fails, or the answer does not parse. Callers decide what
 * a skip means for them.
 */
export async function askFastTier<T>(
  ctx: StudioContext,
  orgId: string,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  /** Log prefix naming the caller, e.g. "[task-board] duplicate check". */
  label: string,
): Promise<{ answer: T } | { skipped: string }> {
  try {
    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, orgId);
    const model = provider.aiSdk.languageModel(tier.modelId);
    const { text, finishReason } = await generateText({
      model,
      instructions: system,
      prompt,
      temperature: 0,
      // Room for a reasoning model to think before the JSON it was asked for.
      maxOutputTokens: 8000,
    });
    const answer = parseModelJson(text, schema);
    if (!answer) {
      console.warn(`${label}: unparseable answer`, {
        modelId: tier.modelId,
        finishReason,
        chars: text.length,
        tail: text.slice(-200),
      });
      return {
        skipped: `unparseable answer from ${tier.modelId} (finish=${finishReason}, chars=${text.length})`,
      };
    }
    return { answer };
  } catch (err) {
    console.warn(`${label} failed`, err);
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}
