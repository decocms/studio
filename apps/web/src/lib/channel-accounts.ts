/** How a channel (`slack`, `discord`…) is named on screen. Product names stay as they are. */
const CHANNEL_NAMES: Record<string, string> = {
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  gchat: "Google Chat",
  whatsapp: "WhatsApp",
  grain: "Grain",
};

export function channelName(channel: string): string {
  return (
    CHANNEL_NAMES[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1)
  );
}
