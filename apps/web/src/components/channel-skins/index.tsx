/**
 * A conversation, drawn the way its channel draws it (skill
 * `channels-design` §6; how each skin is built: skill `channel-skins`).
 * Data in by props, events out by callbacks: the screen maps its rows to
 * `ChatMessage` and picks the skin.
 *
 * Copied from the channels hub (packages/ui/src/components/chat): Studio's
 * avatar and `cn`, its words through `useT` (channelSkins.*), the rest as it
 * was, so the two stay easy to compare.
 */
import "./chat.css";
import { Discord } from "./discord.tsx";
import { GChat } from "./gchat.tsx";
import { Slack } from "./slack.tsx";
import { Transcript } from "./transcript.tsx";
import type { Skin, SkinProps } from "./types.ts";
import { WhatsApp } from "./whatsapp.tsx";

export type * from "./types.ts";

const SKINS: Record<Skin, React.ComponentType<SkinProps>> = {
  whatsapp: WhatsApp,
  discord: Discord,
  slack: Slack,
  gchat: GChat,
  transcript: Transcript,
};

/**
 * The skin a source wears. Grain is a call, read as a transcript; Teams has
 * no skin of its own and its chats look most like Google Chat's (a grey
 * bubble with the name and time above it, ours tinted on the right); any
 * other source reads as bubbles.
 */
export const skinOf = (source: string): Skin =>
  source === "grain"
    ? "transcript"
    : source === "teams"
      ? "gchat"
      : source in SKINS
        ? (source as Skin)
        : "whatsapp";

export function ChatView({ skin, ...props }: SkinProps & { skin: Skin }) {
  const Drawn = SKINS[skin];
  return <Drawn {...props} />;
}
