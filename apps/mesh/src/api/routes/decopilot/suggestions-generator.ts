/**
 * Agent Suggestions Generator
 *
 * Generates 3 starter questions for an agent based on its system prompt,
 * using the same LLM approach as title generation.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText } from "ai";

const SUGGESTIONS_GENERATOR_PROMPT = `Given the following description or instructions for an AI agent, generate 3 short, specific starter questions or requests a user might ask.

Rules:
- Make them specific to this agent's domain, not generic
- Each suggestion under 70 characters
- Use action form: "Can you...?" or direct imperative
- Sentence case only (capitalize first word and proper nouns)
- Return JSON: {"suggestions": ["...", "...", "..."]}

Good example for a Site Diagnostics agent:
{"suggestions": ["Can you audit my website performance?", "Run an SEO analysis on my page", "Check my Core Web Vitals score"]}

Good example for a Code Review agent:
{"suggestions": ["Review my latest pull request", "Can you check for security issues?", "Help me refactor this function"]}`;

export async function genSuggestions(config: {
  abortSignal: AbortSignal;
  model: LanguageModelV3;
  agentDescription: string;
}): Promise<string[] | null> {
  const { abortSignal, model, agentDescription } = config;

  try {
    const result = await generateText({
      model,
      system: SUGGESTIONS_GENERATOR_PROMPT,
      messages: [{ role: "user", content: agentDescription }],
      maxOutputTokens: 200,
      temperature: 0.3,
      abortSignal,
    });

    const cleaned = result.text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    const suggestions = parsed.suggestions;

    if (
      !Array.isArray(suggestions) ||
      !suggestions.every((s) => typeof s === "string")
    ) {
      return null;
    }

    return suggestions.slice(0, 3).map((s: string) =>
      s
        .replace(/^["']|["']$/g, "")
        .replace(/[.!?]$/, "")
        .slice(0, 80)
        .trim(),
    );
  } catch (error) {
    const err = error as Error;
    if (err.name !== "AbortError") {
      console.error("[decopilot:suggestions] Failed to generate:", err.message);
    }
    return null;
  }
}
