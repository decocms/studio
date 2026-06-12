import type { ChannelType } from "@/storage/types";
import { discordAdapter } from "./adapters/discord";
import { teamsAdapter } from "./adapters/teams";
import type { ChannelAdapter } from "./types";

/**
 * Channel types that use the per-org webhook + credentials adapter model.
 * WhatsApp is intentionally excluded — it's a shared-number, enable-only channel
 * with a global ingest route, no per-org credentials, and no adapter.
 */
export type WebhookChannelType = "teams" | "discord";

/**
 * Registry of per-org webhook channel adapters. Mirrors `getProviders()` in the
 * AI-providers feature. Add new credential-based platforms here.
 */
export function getChannelAdapters(): Record<
  WebhookChannelType,
  ChannelAdapter
> {
  return {
    teams: teamsAdapter,
    discord: discordAdapter,
  };
}

/** True for channel types backed by a per-org webhook adapter (not WhatsApp). */
function isWebhookChannelType(type: ChannelType): type is WebhookChannelType {
  return type === "teams" || type === "discord";
}

export function getChannelAdapter(type: ChannelType): ChannelAdapter {
  if (!isWebhookChannelType(type)) {
    throw new Error(`Channel type "${type}" has no webhook adapter`);
  }
  return getChannelAdapters()[type];
}
