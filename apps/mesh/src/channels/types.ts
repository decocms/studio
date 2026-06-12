import type { z } from "zod";
import type { ChannelType } from "@/storage/types";

/**
 * Channel adapter contract. Each chat platform (Teams, Discord) implements one.
 * Adapters are pure integration logic: credential shape + setup guidance for
 * the wizard, inbound signature verification + parsing, and outbound delivery.
 * They never touch the database — the storage/tool/webhook layers own that.
 */

/** A normalized inbound chat message, platform-agnostic. */
export interface ChannelInboundMessage {
  /** Platform user id of the sender. */
  senderId: string;
  /** Human-readable sender name (tagged into the agent's system context). */
  senderName: string;
  /** The message text the user sent to the bot. */
  text: string;
  /**
   * Stable identifier of the ongoing conversation (Discord channel id, Teams
   * conversation id). Used to derive a persistent thread so the agent
   * accumulates memory across turns — distinct from `conversationRef`, which
   * may change per message (e.g. Discord's per-interaction token).
   */
  conversationKey: string;
  /**
   * Opaque, platform-specific handle used by `sendOutbound` to address the
   * reply (e.g. Teams serviceUrl+conversationId, Discord interaction token).
   * Persisted only transiently for the duration of one turn.
   */
  conversationRef: Record<string, unknown>;
}

/**
 * Result of parsing an inbound platform request.
 *
 * - `ack`: a protocol handshake (Discord PING, Teams non-message activity).
 *   Reply with `response` (if any) and do no further work.
 * - `message`: a real user message. Reply to the HTTP request with
 *   `ackResponse` immediately (Discord deferred `{type:5}`; Teams `undefined`
 *   → bare 200), then run the agent turn and deliver via `sendOutbound`.
 */
export type ParsedInbound =
  | { kind: "ack"; response?: unknown }
  | { kind: "message"; message: ChannelInboundMessage; ackResponse?: unknown };

/** One step of the guided setup wizard, rendered on the frontend. */
export interface ChannelSetupStep {
  title: string;
  description: string;
  link?: { label: string; url: string };
}

/** A credential input rendered in the wizard's "paste credentials" step. */
export interface ChannelCredentialField {
  key: string;
  label: string;
  placeholder?: string;
  /** Render as a masked password input and never send to analytics. */
  secret?: boolean;
  optional?: boolean;
  help?: string;
}

export interface ChannelAdapterInfo {
  id: ChannelType;
  name: string;
  description: string;
  logo?: string;
}

export interface ChannelTestResult {
  ok: boolean;
  detail?: string;
  botDisplayName?: string;
}

export interface ChannelAdapter {
  readonly info: ChannelAdapterInfo;
  /** Zod schema validating the per-platform credential blob. */
  readonly credentialSchema: z.ZodType;
  /** Field descriptors for the wizard's credential form. */
  readonly credentialFields: ChannelCredentialField[];
  /** Ordered setup instructions for the wizard. */
  readonly setupInstructions: ChannelSetupStep[];

  /** Verify the inbound request is genuinely from the platform. */
  verifySignature(args: {
    rawBody: ArrayBuffer;
    headers: Headers;
    credentials: Record<string, unknown>;
  }): Promise<boolean>;

  /** Parse a verified inbound payload into a normalized message or ack. */
  parseInbound(payload: unknown): ParsedInbound;

  /** Deliver a reply back into the conversation. */
  sendOutbound(args: {
    credentials: Record<string, unknown>;
    conversationRef: Record<string, unknown>;
    text: string;
  }): Promise<void>;

  /** Probe the credentials (used by CHANNEL_TEST to flip draft → active). */
  testConnection(
    credentials: Record<string, unknown>,
  ): Promise<ChannelTestResult>;

  /** Produce a display-safe masked view of the credentials (for previews). */
  maskCredentials(credentials: Record<string, unknown>): Record<string, string>;
}
