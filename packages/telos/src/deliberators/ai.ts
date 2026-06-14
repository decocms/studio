// LLM deliberation via the Vercel AI SDK v6. The ONLY module that imports `ai`
// (an optional peer dependency), exposed under the "@decocms/telos/ai" subpath so
// the core stays AI-free.
//
// The model is INJECTED (an AI SDK v6 `LanguageModel`, or a provider/gateway model
// string). Model resolution is the caller's concern — standalone you might pass a
// gateway model; inside a host you pass whatever your provider stack produced.

import {
  type LanguageModel,
  Output,
  stepCountIs,
  tool,
  ToolLoopAgent,
} from "ai";
import { z } from "zod";
import { applyAction, type Deliberator } from "../core";

const Report = z.object({
  actionsTaken: z
    .array(z.string())
    .describe("kinds of actions applied this cycle"),
  reasoning: z.string().describe("why these moves close the gap"),
});

export interface AiDeliberatorOptions {
  model: LanguageModel;
  // Hard cap on tool-loop steps per cycle (safety rail). Default 8.
  maxSteps?: number;
  // Optional cap on actions actually applied per cycle (per-tenant safety rail).
  maxActionsPerCycle?: number;
}

export function aiDeliberator(opts: AiDeliberatorOptions): Deliberator {
  const { model, maxSteps = 8, maxActionsPerCycle } = opts;

  return {
    async run({ domain, ctx, instructions, prompt }) {
      let applied = 0;

      const tools = Object.fromEntries(
        domain.actions.map((action) => [
          action.kind,
          tool({
            description: action.description,
            inputSchema: action.schema,
            execute: async (input) => {
              if (
                maxActionsPerCycle !== undefined &&
                applied >= maxActionsPerCycle
              ) {
                return `skipped ${action.kind}: per-cycle action cap (${maxActionsPerCycle}) reached`;
              }
              const outcome = await applyAction(action, ctx, input);
              if (!outcome.applied) {
                return `vetoed ${action.kind}: ${outcome.vetoed}`;
              }
              applied++;
              return `applied ${action.kind}`;
            },
          }),
        ]),
      );

      const agent = new ToolLoopAgent({
        model,
        instructions,
        tools,
        stopWhen: stepCountIs(maxSteps),
        output: Output.object({ schema: Report }),
      });

      const { output } = await agent.generate({ prompt });
      return { summary: output.reasoning, actionsTaken: output.actionsTaken };
    },
  };
}
