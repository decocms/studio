import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { AlertSchema } from "./schema";

export const ALERTS_LIST = defineTool({
  name: "ALERTS_LIST",
  description:
    "List the organization's alerts, newest first: what the monitors saw that waits for someone to look at it (e.g. orders dropping at a store). Open ones by default; `status` picks acked or all, a page at a time.",
  annotations: {
    title: "List Alerts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    /** `open` (default), `acked`, or `all`. */
    status: z.enum(["open", "acked", "all"]).optional(),
    limit: z.number().int().positive().max(200).optional(),
    /** `nextCursor` from the previous page. */
    cursor: z.string().max(200).optional(),
  }),
  outputSchema: z.object({
    alerts: z.array(AlertSchema),
    /** Null on the last page. */
    nextCursor: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    return ctx.storage.alerts.list(org.id, input);
  },
});
