import { z } from "zod";
import { DemoStatusSchema } from "@decocms/shared/demo";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";

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
