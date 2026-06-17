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
     * True when a registered link existed and was disconnected; false when
     * there was nothing to disconnect (already offline / TTL expired).
     */
    disconnected: z.boolean(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const userSub = ctx.auth.user!.id;
    const registry = ctx.linkClaimRegistry;
    const claim = registry ? await registry.get(userSub) : null;
    if (!claim) return { disconnected: false };

    // Order matters: tell the daemon to stop BEFORE deleting the claim. The
    // frame is fire-and-forget (held control long-poll delivers it within
    // the poll window); deleting first would still work, but a daemon that
    // never receives the frame (pre-`shutdown` CLI, NATS hiccup) re-mints
    // the claim on its next poll — the daemon stopping is what makes the
    // disconnect stick, the delete just flips the UI immediately.
    ctx.publishLinkControlFrame?.(userSub, { type: "shutdown" });
    await registry!.delete(userSub);

    return { disconnected: true };
  },
});
