/**
 * propose_plan Built-in Tool
 *
 * Client-side tool for proposing an implementation plan during plan mode.
 * Uses AI SDK tool() function (not MCP defineTool).
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Input schema for propose_plan (Zod)
 * Exported for testing and type inference
 */
const ProposePlanInputSchema = z.object({
  plan: z
    .string()
    .max(50000)
    .describe("Markdown-formatted implementation plan"),
});

export type ProposePlanInput = z.infer<typeof ProposePlanInputSchema>;

/**
 * Output schema for propose_plan (Zod)
 * Exported for testing and type inference
 */
const ProposePlanOutputSchema = z.object({
  approved: z.boolean().describe("Whether the user approved the plan"),
});

export type ProposePlanOutput = z.infer<typeof ProposePlanOutputSchema>;

const description =
  "Propose an implementation plan for user review. Include all discoveries, context, and steps needed — " +
  "this becomes the sole context for execution. After approval, a new thread will be created with this plan " +
  "as the starting context, so anything not included in the plan will be lost.\n\n" +
  "Guidelines:\n" +
  "- Include file paths, function names, and specific code locations discovered during exploration.\n" +
  "- List concrete implementation steps in order.\n" +
  "- Note any risks, dependencies, or trade-offs.";

/**
 * propose_plan tool definition (AI SDK)
 *
 * This is a CLIENT-SIDE tool - it has NO execute function.
 * The tool call is sent to the client, where the UI renders
 * the plan with approve/reject buttons.
 */
export const proposePlanTool = tool({
  description,
  inputSchema: zodSchema(ProposePlanInputSchema),
  outputSchema: zodSchema(ProposePlanOutputSchema),
});
