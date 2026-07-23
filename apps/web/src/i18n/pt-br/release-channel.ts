import type { releaseChannel as releaseChannelEn } from "../en/release-channel.ts";

export const releaseChannel = {
  "releaseChannel.floatingReleaseCard.dismissReleaseAnnouncement":
    "Descartar anúncio de versão",
  "releaseChannel.floatingReleaseCard.releaseAnnouncement": "Anúncio de versão",
} satisfies Record<keyof typeof releaseChannelEn, string>;
