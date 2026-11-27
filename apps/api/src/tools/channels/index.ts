import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { z } from "zod";
import { ConflictError } from "@/core/conflict-error";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";

const SOURCES = [
  "whatsapp",
  "discord",
  "slack",
  "grain",
  "gchat",
  "teams",
] as const;

const ConnectionSchema = z.object({
  id: z.string(),
  source: z.string(),
  external_id: z.string(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  last_event_at: z.string().nullable(),
});

const ConversationSchema = z.object({
  connection_id: z.string(),
  id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  parent_id: z.string().nullable(),
  space: z.string().nullable(),
  started_at: z.string().nullable(),
  last_message_at: z.string().nullable(),
});

const MessageSchema = z.object({
  connection_id: z.string(),
  conversation_id: z.string(),
  id: z.string(),
  author_id: z.string().nullable(),
  author_name: z.string().nullable(),
  ts: z.string(),
  text: z.string().nullable(),
  derived_text: z.string().nullable(),
  kind: z.string().nullable(),
  reply_to: z.string().nullable(),
  thread_id: z.string().nullable(),
  attachments: z.unknown(),
  offset_ms: z.number().nullable(),
  duration_ms: z.number().nullable(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

const limit = (max: number) => z.number().int().min(1).max(max).default(50);

/** Access first, then the product flag: the flag never widens access. */
async function channelsOrg(ctx: StudioContext) {
  requireAuth(ctx);
  const org = requireOrganization(ctx);
  await ctx.access.check();
  const settings = await ctx.storage.organizationSettings.get(org.id);
  if (!orgFlagEnabled(settings?.flags, "channels_enabled")) {
    throw new Error("Channels are not enabled for this organization");
  }
  return org;
}

const NOT_FOUND = "Channel connection not found";

export const CHANNELS_CONNECTION_CREATE = defineTool({
  name: "CHANNELS_CONNECTION_CREATE",
  description:
    "Connect an account at a channel source (a WhatsApp number, a Discord bot…) so its worker can push conversations into Studio. Returns the worker's ingestion token, shown only this once.",
  annotations: {
    title: "Create Channel Connection",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    source: z.enum(SOURCES),
    external_id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(200).optional(),
    kind: z.string().trim().min(1).max(64).optional(),
  }),
  outputSchema: z.object({ connection: ConnectionSchema, token: z.string() }),
  handler: async (input, ctx) => {
    const org = await channelsOrg(ctx);
    const created = await ctx.storage.channels.createConnection({
      organizationId: org.id,
      source: input.source,
      externalId: input.external_id,
      name: input.name,
      kind: input.kind,
      createdBy: getUserId(ctx) ?? null,
    });
    if (!created) {
      throw new ConflictError(
        "This account is already connected in this organization.",
      );
    }
    return created;
  },
});

export const CHANNELS_CONNECTION_ROTATE_TOKEN = defineTool({
  name: "CHANNELS_CONNECTION_ROTATE_TOKEN",
  description:
    "Issue a new ingestion token for a channel connection. The old token stops working at once; the new one is shown only this once.",
  annotations: {
    title: "Rotate Channel Token",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1).max(100) }),
  outputSchema: z.object({ token: z.string() }),
  handler: async (input, ctx) => {
    const org = await channelsOrg(ctx);
    const token = await ctx.storage.channels.rotateToken(org.id, input.id);
    if (!token) throw new Error(NOT_FOUND);
    return { token };
  },
});

export const CHANNELS_CONNECTION_LIST = defineTool({
  name: "CHANNELS_CONNECTION_LIST",
  description: "List the organization's channel connections.",
  annotations: {
    title: "List Channel Connections",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ connections: z.array(ConnectionSchema) }),
  handler: async (_, ctx) => {
    const org = await channelsOrg(ctx);
    return {
      connections: await ctx.storage.channels.listConnections(org.id),
    };
  },
});

export const CHANNELS_CONNECTION_DELETE = defineTool({
  name: "CHANNELS_CONNECTION_DELETE",
  description:
    "Delete a channel connection with every conversation, person and message it brought in. Its token stops working.",
  annotations: {
    title: "Delete Channel Connection",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1).max(100) }),
  outputSchema: z.object({ deleted: z.boolean() }),
  handler: async (input, ctx) => {
    const org = await channelsOrg(ctx);
    return {
      deleted: await ctx.storage.channels.deleteConnection(org.id, input.id),
    };
  },
});

export const CHANNELS_CONVERSATION_LIST = defineTool({
  name: "CHANNELS_CONVERSATION_LIST",
  description:
    "List channel conversations, newest activity first. Filter by connection or by a piece of the title; page with the returned cursor.",
  annotations: {
    title: "List Channel Conversations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    connection_id: z.string().min(1).max(100).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: limit(200),
    cursor: z.string().max(2000).optional(),
  }),
  outputSchema: z.object({
    conversations: z.array(ConversationSchema),
    next_cursor: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    const org = await channelsOrg(ctx);
    const page = await ctx.storage.channels.listConversations(org.id, {
      connectionId: input.connection_id,
      query: input.query,
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      conversations: page.conversations,
      next_cursor: page.nextCursor,
    };
  },
});

export const CHANNELS_MESSAGE_LIST = defineTool({
  name: "CHANNELS_MESSAGE_LIST",
  description:
    "Read a channel conversation's messages, newest first. Pass the returned `next_before` as `before` for older ones.",
  annotations: {
    title: "List Channel Messages",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    connection_id: z.string().min(1).max(100),
    conversation_id: z.string().min(1).max(512),
    limit: limit(500),
    before: z.string().max(2000).optional(),
  }),
  outputSchema: z.object({
    messages: z.array(MessageSchema),
    next_before: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    const org = await channelsOrg(ctx);
    const page = await ctx.storage.channels.listMessages(org.id, {
      connectionId: input.connection_id,
      conversationId: input.conversation_id,
      limit: input.limit,
      before: input.before,
    });
    return { messages: page.messages, next_before: page.nextBefore };
  },
});

export const CHANNELS_MESSAGE_SEARCH = defineTool({
  name: "CHANNELS_MESSAGE_SEARCH",
  description:
    "Full-text search over channel messages (their text and transcriptions), newest first. Accepts web-search syntax: quotes, OR, -word.",
  annotations: {
    title: "Search Channel Messages",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500),
    connection_id: z.string().min(1).max(100).optional(),
    limit: limit(200),
  }),
  outputSchema: z.object({ messages: z.array(MessageSchema) }),
  handler: async (input, ctx) => {
    const org = await channelsOrg(ctx);
    return {
      messages: await ctx.storage.channels.searchMessages(org.id, {
        query: input.query,
        connectionId: input.connection_id,
        limit: input.limit,
      }),
    };
  },
});
