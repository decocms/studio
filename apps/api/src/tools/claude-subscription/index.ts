/**
 * Linking a user's own Claude subscription to their sandbox-hosted
 * `claude-code` runs.
 *
 * The token is minted OUTSIDE Studio, by Anthropic's own client:
 * `claude setup-token` on the user's machine. Studio deliberately does not
 * drive the OAuth flow itself — doing so would mean borrowing Anthropic's
 * client id, and for an account with both a claude.ai subscription and a
 * Console organization that client is reported to resolve to the Console org
 * and bill API credit (anthropics/claude-code#39445). Letting the user
 * authorize in Anthropic's UI makes "which account pays" their explicit
 * choice, visible to them, instead of something Studio infers silently.
 */

import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";

const statusSchema = z.object({
  connected: z.boolean(),
  linkedAt: z.string().nullable(),
  expiresAt: z
    .string()
    .nullable()
    .describe("Known expiry, or null when the token carries none we can read"),
});

/**
 * `sk-ant-api…` is a Console API key: pasting one would work and would bill
 * per-token API usage — the exact outcome this feature exists to avoid — so it
 * is rejected by name rather than silently accepted. Any other shape is let
 * through: only Anthropic can really validate the token, and guessing at the
 * OAuth prefix would reject valid tokens the day the format changes.
 */
const CONSOLE_API_KEY_PREFIX = "sk-ant-api";

/** Returns the token to store, or throws with what the user should do instead. */
export function normalizeSubscriptionToken(pasted: string): string {
  const token = pasted.trim();
  if (token.startsWith(CONSOLE_API_KEY_PREFIX)) {
    throw new Error(
      "That looks like a Console API key, which bills per-token API usage " +
        "instead of your subscription. Run `claude setup-token` and paste " +
        "the token it prints.",
    );
  }
  if (/\s/.test(token)) {
    throw new Error("The token must not contain spaces or line breaks");
  }
  if (token.length === 0) throw new Error("The token must not be empty");
  return token;
}

export const CLAUDE_SUBSCRIPTION_CONNECT = defineTool({
  name: "CLAUDE_SUBSCRIPTION_CONNECT",
  description:
    "Link the caller's Claude subscription with a token from " +
    "`claude setup-token`, so their claude-code runs bill against their own " +
    "Pro/Max plan. Stored encrypted, for the caller only.",
  inputSchema: z.object({
    token: z
      .string()
      .min(1)
      .describe("The token printed by `claude setup-token` (sk-ant-oat…)"),
  }),
  outputSchema: statusSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const token = normalizeSubscriptionToken(input.token);
    const stored = await ctx.storage.claudeSubscriptions.upsert({
      userId,
      accessToken: token,
    });
    return { connected: true, ...stored };
  },
});

export const CLAUDE_SUBSCRIPTION_STATUS = defineTool({
  name: "CLAUDE_SUBSCRIPTION_STATUS",
  description:
    "Whether the caller has a linked Claude subscription token, and since when.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const found = await ctx.storage.claudeSubscriptions.find(userId);
    if (!found) return { connected: false, linkedAt: null, expiresAt: null };
    // A null expiry is live — unknown lifetime, not zero.
    const expired =
      found.expiresAt !== null && new Date(found.expiresAt) <= new Date();
    return { connected: !expired, ...found };
  },
});

export const CLAUDE_SUBSCRIPTION_DISCONNECT = defineTool({
  name: "CLAUDE_SUBSCRIPTION_DISCONNECT",
  description:
    "Unlink the caller's Claude subscription and delete the stored token.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    await ctx.storage.claudeSubscriptions.delete(userId);
    return { connected: false, linkedAt: null, expiresAt: null };
  },
});
