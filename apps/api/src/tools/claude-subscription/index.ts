import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import {
  generateCodeChallenge,
  generateCodeVerifier,
} from "../../ai-providers/pkce";
import {
  claudeSubscriptionAuthorizeUrl,
  exchangeClaudeSubscriptionCode,
  splitPastedCode,
} from "../../ai-providers/claude-subscription-oauth";

const statusSchema = z.object({
  connected: z.boolean(),
  expiresAt: z
    .string()
    .nullable()
    .describe("When the linked token stops working; re-link after that"),
});

export const CLAUDE_SUBSCRIPTION_LOGIN_URL = defineTool({
  name: "CLAUDE_SUBSCRIPTION_LOGIN_URL",
  description:
    "Start linking the caller's Claude subscription (Pro/Max) so their " +
    "claude-code runs bill against it. Returns an authorization URL to open; " +
    "Anthropic shows a code to paste into CLAUDE_SUBSCRIPTION_CONNECT.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    url: z.string(),
    stateToken: z
      .string()
      .describe("Opaque token — pass to CLAUDE_SUBSCRIPTION_CONNECT"),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const codeVerifier = generateCodeVerifier();
    const stateToken = await ctx.storage.oauthPkceStates.create(
      codeVerifier,
      org.id,
      userId,
    );
    return {
      url: claudeSubscriptionAuthorizeUrl({
        codeChallenge: generateCodeChallenge(codeVerifier),
        state: stateToken,
      }),
      stateToken,
    };
  },
});

export const CLAUDE_SUBSCRIPTION_CONNECT = defineTool({
  name: "CLAUDE_SUBSCRIPTION_CONNECT",
  description:
    "Finish linking a Claude subscription with the code Anthropic showed " +
    "after authorization. The credential is stored encrypted for the caller " +
    "only, for at most 24 hours.",
  inputSchema: z.object({
    code: z
      .string()
      .min(1)
      .describe("The code Anthropic displayed; the `code#state` form is fine"),
    stateToken: z
      .string()
      .describe("The stateToken returned by CLAUDE_SUBSCRIPTION_LOGIN_URL"),
  }),
  outputSchema: statusSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const pasted = splitPastedCode(input.code);
    // The pasted half is what Anthropic will verify against the token request;
    // it must be the state this user started the flow with, not a third
    // party's, so the verifier lookup below is the authoritative check.
    if (pasted.state && pasted.state !== input.stateToken) {
      throw new Error("The pasted code does not belong to this login attempt");
    }

    const codeVerifier = await ctx.storage.oauthPkceStates.consume(
      input.stateToken,
      org.id,
      userId,
    );
    const token = await exchangeClaudeSubscriptionCode({
      code: pasted.code,
      state: input.stateToken,
      codeVerifier,
    });
    const stored = await ctx.storage.claudeSubscriptions.upsert({
      userId,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
    });
    return { connected: true, expiresAt: stored.expiresAt };
  },
});

export const CLAUDE_SUBSCRIPTION_STATUS = defineTool({
  name: "CLAUDE_SUBSCRIPTION_STATUS",
  description:
    "Whether the caller has a linked Claude subscription, and when it expires.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const found = await ctx.storage.claudeSubscriptions.find(userId);
    return {
      connected: found !== null && new Date(found.expiresAt) > new Date(),
      expiresAt: found?.expiresAt ?? null,
    };
  },
});

export const CLAUDE_SUBSCRIPTION_DISCONNECT = defineTool({
  name: "CLAUDE_SUBSCRIPTION_DISCONNECT",
  description:
    "Unlink the caller's Claude subscription and delete the stored credential.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    await ctx.storage.claudeSubscriptions.delete(userId);
    return { connected: false, expiresAt: null };
  },
});
