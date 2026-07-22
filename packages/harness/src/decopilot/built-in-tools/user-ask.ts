/**
 * user_ask Built-in Tool
 *
 * Client-side tool for gathering user input during task execution.
 * Uses AI SDK tool() function (not MCP defineTool).
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Input schema for user_ask (Zod)
 * Exported for testing and type inference
 */
export const UserAskInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe(
        "One short question (1 sentence max, ≤15 words). The conversation already provides context, do not repeat it here.",
      ),
    type: z
      .enum(["text", "choice", "confirm"])
      .describe(
        "'text': free-form, 'choice': pick from options (UI adds 'Other' automatically), 'confirm': yes/no",
      ),
    options: z
      .array(z.string())
      .optional()
      .describe(
        "Required for 'choice'. Each option must be a short label (3–6 words, no leading numbers like '1)' — the UI adds them).",
      ),
    default: z.string().optional(),
  })
  .refine(
    (data) => {
      // If type is 'choice', options must be provided with at least 2 items
      if (data.type === "choice") {
        return data.options && data.options.length >= 2;
      }
      return true;
    },
    {
      message: "Options array with at least 2 items required for 'choice' type",
      path: ["options"],
    },
  );

export type UserAskInput = z.infer<typeof UserAskInputSchema>;

/**
 * Output schema for user_ask (Zod)
 * Exported for testing and type inference
 */
export const UserAskOutputSchema = z.object({
  response: z.string().describe("User's response"),
});

export type UserAskOutput = z.infer<typeof UserAskOutputSchema>;

const description =
  "Ask the user instead of guessing when requirements are ambiguous, multiple valid approaches exist, " +
  "or before actions with significant consequences. Prefer this tool over asking in plain text.\n\n" +
  "Guidelines:\n" +
  "- Keep `prompt` to one short question (1 sentence max, ≤15 words). Never repeat context already visible in the conversation.\n" +
  "- For 'choice' type: put the recommended option first. Provide 2-5 options. Each option label must be 3–6 words — no leading '1)' numbering (the UI adds numbers automatically).\n" +
  "- For 'confirm' type: use for yes/no decisions, especially before destructive or hard-to-reverse actions.\n" +
  "- For 'text' type: use when the answer is open-ended and cannot be anticipated with options.";

/**
 * user_ask tool definition (AI SDK)
 *
 * This is a CLIENT-SIDE tool - it has NO execute function.
 * The tool call is sent to the client, where the UI renders
 * an interactive prompt and the user provides a response.
 */
export const userAskTool = tool({
  description,
  inputSchema: zodSchema(UserAskInputSchema),
  outputSchema: zodSchema(UserAskOutputSchema),
});
