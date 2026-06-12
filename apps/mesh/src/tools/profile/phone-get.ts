import z from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/studio-context";
import { maskPhone } from "@/channels/phone";
import {
  getConciergeNumber,
  isWhatsappConfigured,
} from "@/channels/whatsapp-worker";

/**
 * Current WhatsApp link state for the caller. The profile UI polls this so it
 * flips to "verified" once the user's code arrives via the ingest route.
 */
export const PHONE_GET = defineTool({
  name: "PHONE_GET",
  description: "Get the caller's WhatsApp phone link status.",
  annotations: { readOnlyHint: true },
  inputSchema: z.object({}),
  outputSchema: z.object({
    configured: z.boolean(),
    status: z.enum(["none", "pending", "verified"]),
    code: z.string().optional(),
    conciergeNumber: z.string().optional(),
    maskedPhone: z.string().optional(),
    selectedOrganizationId: z.string().nullable().optional(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Authentication required");

    const configured = isWhatsappConfigured();
    const link = await ctx.storage.userPhones.getByUser(userId);

    return {
      configured,
      status: link?.status ?? "none",
      code: link?.status === "pending" ? (link.code ?? undefined) : undefined,
      conciergeNumber: getConciergeNumber(),
      maskedPhone:
        link?.status === "verified" && link.phone
          ? maskPhone(link.phone)
          : undefined,
      selectedOrganizationId: link?.selectedOrganizationId ?? null,
    };
  },
});
