import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

// The pursuit model is optional: with no key configured, deliberation falls back
// to the domain's deterministic plan(). Mirrors research.ts's OpenRouter wiring.
const PURSUIT_MODEL = process.env.TELOS_PURSUIT_MODEL ?? "openai/gpt-4o-mini";

export function resolvePursuitModel(): LanguageModel | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return createOpenRouter({ apiKey })(PURSUIT_MODEL);
}
