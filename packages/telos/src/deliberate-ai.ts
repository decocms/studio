// LLM deliberation via the Vercel AI SDK v6. The ONLY module that imports `ai`
// (an optional peer dep), exposed under the "@decocms/telos/ai" subpath so the
// core stays AI-free. The model is INJECTED — resolution is the caller's job, so
// this works the same standalone (a gateway string) or inside a host (a provider
// model instance).

import {
  type LanguageModel,
  Output,
  stepCountIs,
  tool,
  ToolLoopAgent,
} from "ai";
import { z } from "zod";
import type { Deliberator } from "./core";

const Report = z.object({
  actionsTaken: z
    .array(z.string())
    .describe("kinds of actions applied this cycle"),
  reasoning: z.string().describe("why these moves close the gap"),
});

export interface AiDeliberatorOptions {
  model: LanguageModel;
  maxSteps?: number;
  // Cap on actions actually applied per cycle (a per-tenant safety rail).
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
              await action.apply(ctx.tenant, input);
              await ctx.record(action.kind, input);
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
