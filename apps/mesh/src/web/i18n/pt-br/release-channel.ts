import type { releaseChannel as releaseChannelEn } from "../en/release-channel.ts";

export const releaseChannel = {
  "releaseChannel.floatingReleaseCard.dismissReleaseAnnouncement":
    "Descartar an\u00fancio de vers\u00e3o",
  "releaseChannel.floatingReleaseCard.releaseAnnouncement":
    "An\u00fancio de vers\u00e3o",
} satisfies Record<keyof typeof releaseChannelEn, string>;
