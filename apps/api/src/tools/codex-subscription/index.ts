import z from "zod";
import { createHash } from "node:crypto";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import { normalizeCodexAuth } from "./auth";

const statusSchema = z.object({
  connected: z.boolean(),
  linkedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const authJson = z.string().min(1).max(131072);

async function caller(ctx: StudioContext): Promise<string> {
  requireAuth(ctx);
  requireOrganization(ctx);
  await ctx.access.check();
  const userId = getUserId(ctx);
  if (!userId) throw new Error("Unable to determine user ID");
  return userId;
}

export const CODEX_SUBSCRIPTION_CONNECT = defineTool({
  name: "CODEX_SUBSCRIPTION_CONNECT",
  description:
    "Link the caller's ChatGPT subscription using the auth.json cache from codex login. Stored encrypted for the caller only.",
  inputSchema: z.object({ authJson }),
  outputSchema: statusSchema,
  handler: async (input, ctx) => {
    const userId = await caller(ctx);
    const stored = await ctx.storage.codexSubscriptions.upsert(
      userId,
      normalizeCodexAuth(input.authJson),
    );
    return { connected: true, ...stored };
  },
});

export const CODEX_SUBSCRIPTION_STATUS = defineTool({
  name: "CODEX_SUBSCRIPTION_STATUS",
  description:
    "Whether the caller has linked their ChatGPT subscription for Codex.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_, ctx) => {
    const found = await ctx.storage.codexSubscriptions.find(await caller(ctx));
    return found
      ? { connected: true, ...found }
      : { connected: false, linkedAt: null, expiresAt: null };
  },
});

export const CODEX_SUBSCRIPTION_DISCONNECT = defineTool({
  name: "CODEX_SUBSCRIPTION_DISCONNECT",
  description:
    "Unlink the caller's ChatGPT subscription and delete its credentials.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_, ctx) => {
    await ctx.storage.codexSubscriptions.delete(await caller(ctx));
    return { connected: false, linkedAt: null, expiresAt: null };
  },
});

export const CODEX_SUBSCRIPTION_SYNC = defineTool({
  name: "CODEX_SUBSCRIPTION_SYNC",
  description:
    "Persist credentials refreshed by the caller's Codex runtime, only while the original login is still current.",
  inputSchema: z.object({
    authJson,
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  outputSchema: z.object({
    updated: z.boolean(),
    authHash: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    const userId = await caller(ctx);
    const auth = normalizeCodexAuth(input.authJson);
    const updated = await ctx.storage.codexSubscriptions.sync(
      userId,
      input.previousHash,
      auth,
    );
    return {
      updated,
      authHash: updated
        ? createHash("sha256").update(auth).digest("hex")
        : null,
    };
  },
});
