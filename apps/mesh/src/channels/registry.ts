import type { ChannelType } from "@/storage/types";
import { discordAdapter } from "./adapters/discord";
import { teamsAdapter } from "./adapters/teams";
import type { ChannelAdapter } from "./types";

/**
 * Registry of supported chat-channel adapters, keyed by channel type. Mirrors
 * `getProviders()` in the AI-providers feature. Add new platforms here.
 */
export function getChannelAdapters(): Record<ChannelType, ChannelAdapter> {
  return {
    teams: teamsAdapter,
    discord: discordAdapter,
  };
}

export function getChannelAdapter(type: ChannelType): ChannelAdapter {
  const adapter = getChannelAdapters()[type];
  if (!adapter) {
    throw new Error(`Unsupported channel type: ${type}`);
  }
  return adapter;
}
