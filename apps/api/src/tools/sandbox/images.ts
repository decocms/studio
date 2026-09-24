import { z } from "zod";
import { SandboxImageSchema } from "@decocms/shared/git-providers";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { listSandboxImages } from "../../sandbox/lifecycle";

export const SANDBOX_IMAGE_LIST = defineTool({
  name: "SANDBOX_IMAGE_LIST",
  description:
    "List the sandbox image variants a repository can pick on this deployment, besides the default image.",
  annotations: {
    title: "List sandbox images",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({}),
  outputSchema: z.object({
    images: z.array(SandboxImageSchema),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    requireOrganization(ctx);
    return { images: await listSandboxImages(ctx) };
  },
});
