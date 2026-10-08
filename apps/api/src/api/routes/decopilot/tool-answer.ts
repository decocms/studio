/**
 * The user's answer to a claude-code interactive tool (`user_ask`,
 * `suggest_task`). Claude Code cannot take a tool result injected into a
 * resumed session, so the answer arrives as a normal message carrying
 * `metadata.toolOutput`: the tool part is resolved in storage and the message
 * text becomes the next turn's prompt.
 */

import { z } from "zod";

const ToolOutputMetadataSchema = z.object({
  toolOutput: z.object({
    toolCallId: z.string().min(1),
    output: z.unknown(),
  }),
});

export type ToolOutputAnswer = z.infer<
  typeof ToolOutputMetadataSchema
>["toolOutput"];

/** The answer a message carries, or null for an ordinary message. */
export function toolOutputAnswer(metadata: unknown): ToolOutputAnswer | null {
  const parsed = ToolOutputMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.toolOutput : null;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/** The prompt that tells the model what the user answered to which question. */
export function answerPrompt(part: Record<string, unknown>): string {
  const output = part.output;
  const question =
    part.type === "tool-suggest_task"
      ? `Create the task "${stringField(part.input, "title") ?? ""}"?`
      : (stringField(part.input, "prompt") ?? "");
  const accepted =
    typeof output === "object" && output !== null
      ? (output as { accepted?: unknown }).accepted
      : undefined;
  const response =
    stringField(output, "response") ??
    (typeof accepted === "boolean"
      ? accepted
        ? "Yes"
        : "No"
      : JSON.stringify(output));
  return question ? `Answer to "${question}": ${response}` : response;
}
