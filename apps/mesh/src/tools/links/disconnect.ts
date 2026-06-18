import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";

export const LINK_DISCONNECT = defineTool({
  name: "LINK_DISCONNECT",
  description:
    "Disconnect the calling user's desktop link from the Studio side: tells the linked daemon to shut down (via a `shutdown` control frame) and removes the presence claim. The user re-links by running `bunx decocms@latest link` on the desktop.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    /**
     * True when a shutdown frame was published to the caller's channel; false
     * when no frame publisher is wired (test / no-NATS contexts).
     */
    disconnected: z.boolean(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const userSub = ctx.auth.user!.id;
    if (!ctx.publishLinkControlFrame) return { disconnected: false };
    ctx.publishLinkControlFrame(userSub, { type: "shutdown" });
    return { disconnected: true };
  },
});
