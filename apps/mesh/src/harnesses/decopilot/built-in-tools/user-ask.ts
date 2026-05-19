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
    prompt: z.string().min(1).describe("The question to display"),
    type: z
      .enum(["text", "choice", "confirm"])
      .describe(
        "'text': free-form, 'choice': pick from options (UI adds 'Other' automatically), 'confirm': yes/no",
      ),
    options: z.array(z.string()).optional().describe("Required for 'choice'"),
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
  "- For 'choice' type: put the recommended option first. Provide 2-5 options.\n" +
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
