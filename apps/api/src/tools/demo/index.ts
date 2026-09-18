import { z } from "zod";
import { DemoRecipeSchema, DemoStatusSchema } from "@decocms/shared/demo";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";
import { emitDemoUpdated } from "@/demo/events";

async function principal(ctx: StudioContext) {
  requireAuth(ctx);
  await ctx.access.check();
  if (!ctx.organization || !getUserId(ctx))
    throw new Error("Organization and signed-in user required");
  return { org: ctx.organization.id, actor: getUserId(ctx)! };
}
export const DEMO_STATUS = defineTool({
  name: "DEMO_STATUS",
  description:
    "Read the registered demonstration scenario and its current generation.",
  inputSchema: z.object({}),
  outputSchema: z.object({ demo: DemoStatusSchema.nullable() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_, ctx) => {
    const { org } = await principal(ctx);
    return { demo: await ctx.storage.demo.status(org) };
  },
});
export const DEMO_RESET = defineTool({
  name: "DEMO_RESET",
  description:
    "Restore the registered demonstration. Discards its task and chat changes, preserving membership and authentication.",
  inputSchema: z.object({
    idempotencyKey: z.string().min(1).max(100),
    expectedGeneration: z.number().int().nonnegative(),
  }),
  outputSchema: z.object({ generation: z.number(), repeated: z.boolean() }),
  handler: async (input, ctx) => {
    const { org, actor } = await principal(ctx);
    const result = await ctx.storage.demo.reset(
      org,
      actor,
      input.idempotencyKey,
      input.expectedGeneration,
    );
    emitDemoUpdated(org);
    return result;
  },
});
export const DEMO_SESSION = defineTool({
  name: "DEMO_SESSION",
  description:
    "Reserve or release the demonstration for the current presenter for 90 minutes.",
  inputSchema: z.object({ active: z.boolean() }),
  outputSchema: z.object({ success: z.boolean() }),
  handler: async ({ active }, ctx) => {
    const { org, actor } = await principal(ctx);
    await ctx.storage.demo.reserve(org, actor, active);
    emitDemoUpdated(org);
    return { success: true };
  },
});
export const DEMO_CREATE_TASK = defineTool({
  name: "DEMO_CREATE_TASK",
  description:
    "Create a task explicitly linked to a prepared demonstration recipe.",
  inputSchema: z.object({
    recipe: DemoRecipeSchema,
    expectedGeneration: z.number().int().nonnegative(),
  }),
  outputSchema: z.object({ id: z.string() }),
  handler: async (input, ctx) => {
    const { org, actor } = await principal(ctx);
    const result = await ctx.storage.demo.createTask(
      org,
      actor,
      input.recipe,
      input.expectedGeneration,
    );
    emitDemoUpdated(org);
    return result;
  },
});
