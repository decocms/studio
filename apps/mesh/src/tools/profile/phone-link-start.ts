import { randomInt } from "node:crypto";
import z from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/studio-context";
import {
  getConciergeNumber,
  isWhatsappConfigured,
} from "@/channels/whatsapp-worker";

// Distinctive, unambiguous alphabet (no 0/O/1/I/L) so codes are easy to type
// and unlikely to collide with a normal chat message.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60_000;

function generateCode(): string {
  let body = "";
  for (let i = 0; i < 6; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `DECO-${body}`;
}

/**
 * Begin linking the caller's WhatsApp number. Studio issues a one-time code;
 * the user proves ownership by sending it FROM their WhatsApp to the concierge
 * number (verification completes in the ingest route, not here).
 */
export const PHONE_LINK_START = defineTool({
  name: "PHONE_LINK_START",
  description:
    "Start linking your WhatsApp number: returns a code to send to the concierge number.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    code: z.string(),
    conciergeNumber: z.string(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    if (!isWhatsappConfigured()) {
      throw new Error("WhatsApp is not configured for this deployment");
    }

    const code = generateCode();
    await ctx.storage.userPhones.issueCode(userId, code, CODE_TTL_MS);

    return { code, conciergeNumber: getConciergeNumber() ?? "" };
  },
});
