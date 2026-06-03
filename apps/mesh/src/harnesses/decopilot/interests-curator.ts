/**
 * Interests Curator
 *
 * Maintains a user's "interests" memory with a cheap `generateObject` call on
 * the org's fast model. The model rewrites the whole list (like `todo_write`):
 * it's shown the current interests plus a recent transcript and returns the
 * full set it wants going forward.
 *
 * Scheduling/debouncing is owned by the DBOS workflow that calls this — see
 * `interests-curator-workflow.ts`. This module is pure model + storage logic.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { generateObject } from "ai";
import { z } from "zod";
import type { InterestsDoc, InterestsStorage } from "@/storage/interests";

const CURATOR_TIMEOUT_MS = 30_000;
/** Cap on transcript turns + per-turn chars to keep the curator call cheap. */
const MAX_TRANSCRIPT_TURNS = 12;
const MAX_TURN_CHARS = 800;

const CuratedSchema = z.object({
  interests: z.array(
    z.object({
      title: z.string().describe("Short noun phrase, e.g. 'Learning Rust'"),
      summary: z
        .string()
        .describe("One or two sentences of context, including any progress"),
    }),
  ),
});

const CURATOR_PROMPT = `You maintain a durable record of what a user is working toward, based on their conversations with an AI agent.

You are given the user's CURRENT interests (may be empty) and a recent conversation transcript. Return the FULL list of interests you want to keep going forward, most important first.

Rules:
- Carry forward existing interests unchanged unless the conversation clearly updates them. Fold any progress into the summary.
- Drop an interest only when it's clearly finished or abandoned.
- Add a new interest only when the conversation reveals a genuine, durable goal — not a one-off question. Be conservative; most conversations add nothing new.
- Keep titles short and summaries factual. No speculation. Aim for at most ~10 interests.`;

function textFromContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

/** Compact recent user/assistant turns into a transcript string. */
export function buildCuratorTranscript(messages: ModelMessage[]): string {
  return messages
    .slice(-MAX_TRANSCRIPT_TURNS)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text = textFromContent(m.content).slice(0, MAX_TURN_CHARS).trim();
      return text ? `${m.role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildCuratorInput(current: InterestsDoc, transcript: string): string {
  const existing = current.interests.length
    ? JSON.stringify(current.interests, null, 2)
    : "(none yet)";
  return `## Current interests\n${existing}\n\n## Recent conversation\n${transcript}`;
}

/**
 * Run interest curation: read the doc, ask the model for the full updated
 * list, write it back. Never throws — failures and aborts are swallowed so
 * callers can run it detached.
 */
export async function curateInterests(config: {
  model: LanguageModelV3;
  orgId: string;
  userId: string;
  storage: InterestsStorage;
  transcript: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { model, orgId, userId, storage, transcript, abortSignal } = config;
  if (abortSignal?.aborted || !transcript.trim()) return;
  try {
    const current = (await storage.getForUser(orgId, userId)) ?? {
      interests: [],
    };
    const signal = AbortSignal.any([
      AbortSignal.timeout(CURATOR_TIMEOUT_MS),
      ...(abortSignal ? [abortSignal] : []),
    ]);
    const { object } = await generateObject({
      model,
      schema: CuratedSchema,
      system: CURATOR_PROMPT,
      messages: [
        { role: "user", content: buildCuratorInput(current, transcript) },
      ],
      temperature: 0.2,
      abortSignal: signal,
    });
    await storage.setForUser(orgId, userId, { interests: object.interests });
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || e.name === "TimeoutError") return;
    console.warn("[decopilot:interests] curation failed:", e.message);
  }
}
