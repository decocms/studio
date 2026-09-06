import type { releaseChannel as releaseChannelEn } from "../en/release-channel.ts";

export const releaseChannel = {} satisfies Record<
  keyof typeof releaseChannelEn,
  string
>;
