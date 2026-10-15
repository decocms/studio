/**
 * Linking a user's GitHub Copilot plan to their sandbox-hosted `claude-code`
 * runs. Copilot serves Claude models on an Anthropic-compatible
 * `/v1/messages`, which the CLI reaches with the user's GitHub token as a
 * bearer — no token exchange and no borrowed editor client id.
 *
 * The token is a fine-grained personal access token with the "Copilot
 * Requests" permission, the credential GitHub documents for Copilot CLI. It
 * is the user's own seat, so it is stored per user and never shared.
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
});

/** Classic PATs are refused by Copilot (GitHub's Copilot CLI auth docs). */
const CLASSIC_PAT_PREFIX = "ghp_";

/** Returns the token to store, or throws with what the user should do instead. */
export function normalizeCopilotToken(pasted: string): string {
  const token = pasted.trim();
  if (token.length === 0) throw new Error("The token must not be empty");
  if (/\s/.test(token)) {
    throw new Error("The token must not contain spaces or line breaks");
  }
  if (token.startsWith(CLASSIC_PAT_PREFIX)) {
    throw new Error(
      "Classic personal access tokens do not work with Copilot. Create a " +
        "fine-grained token with the Copilot Requests permission.",
    );
  }
  return token;
}

export const GITHUB_COPILOT_CONNECT = defineTool({
  name: "GITHUB_COPILOT_CONNECT",
  description:
    "Link the caller's GitHub Copilot plan with a fine-grained personal " +
    "access token, so their claude-code runs use Claude through Copilot. " +
    "Stored encrypted, for the caller only.",
  inputSchema: z.object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        "A fine-grained GitHub token (github_pat_…) with the Copilot Requests permission",
      ),
  }),
  outputSchema: statusSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const { linkedAt } = await ctx.storage.githubCopilotSubscriptions.upsert({
      userId,
      accessToken: normalizeCopilotToken(input.token),
    });
    return { connected: true, linkedAt };
  },
});

export const GITHUB_COPILOT_STATUS = defineTool({
  name: "GITHUB_COPILOT_STATUS",
  description: "Whether the caller has linked a GitHub Copilot token.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const found = await ctx.storage.githubCopilotSubscriptions.find(userId);
    return { connected: found !== null, linkedAt: found?.linkedAt ?? null };
  },
});

export const GITHUB_COPILOT_DISCONNECT = defineTool({
  name: "GITHUB_COPILOT_DISCONNECT",
  description: "Unlink the caller's GitHub Copilot token and delete it.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    await ctx.storage.githubCopilotSubscriptions.delete(userId);
    return { connected: false, linkedAt: null };
  },
});
