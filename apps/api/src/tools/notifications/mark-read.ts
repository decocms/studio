import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { requireOrg } from "./org";

export const NOTIFICATION_MARK_READ = defineTool({
  name: "NOTIFICATION_MARK_READ",
  description:
    "Mark notifications read. Omit `ids` to mark all of the current user's unread ones in this organization.",
  annotations: {
    title: "Mark Notifications Read",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ ids: z.array(z.string()).optional() }),
  outputSchema: z.object({ marked: z.number() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const marked = await ctx.storage.notifications.markRead(
      getUserId(ctx)!,
      requireOrg(ctx),
      input.ids,
    );
    return { marked };
  },
});
