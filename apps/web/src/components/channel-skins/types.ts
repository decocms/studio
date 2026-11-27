/**
 * One message, the same shape whatever channel it came from. Each data source
 * (the hub's list_messages, a channel's own tool) maps its rows to this; each
 * skin draws it the way its channel does (skill `channel-skins`).
 */
export interface ChatMessage {
  id: string;
  /** ISO time; null when the source has none. */
  ts: string | null;
  author: ChatAuthor | null;
  /** Ours: the side a channel with sides puts its own messages on. */
  mine?: boolean;
  text?: string | null;
  /** Under the media, quieter: a voice note's transcript. */
  note?: string | null;
  /** Sensitive content the caller may not read: the skin says so. */
  withheld?: boolean;
  deleted?: boolean;
  edited?: boolean;
  forwarded?: boolean;
  /** A notice from the channel itself ("Ana added Rafael"), not from a person. */
  system?: string | null;
  reply?: { author: string | null; text: string | null } | null;
  reactions?: ChatReaction[];
  media?: ChatMedia[];
  /** Link previews and bots' cards (Discord's embeds). Skins without them ignore it. */
  embeds?: ChatEmbed[];
  /** Link buttons under it (Discord's components). Skins without them ignore it. */
  buttons?: { label: string; url: string }[];
  /** A thread hanging from this message. */
  thread?: { title?: string | null; count?: number | null } | null;
  /** A call: how far into it this was said. */
  offsetMs?: number | null;
}

export interface ChatAuthor {
  /** Stable per person where the source has one: groups and colours follow it. */
  id?: string | null;
  name: string | null;
  photo?: string | null;
  /** Beside the name where the channel shows one: a phone number. */
  handle?: string | null;
  /** A small label after the name: how we classify them ("deco", "Cliente"). Ours, not the channel's. */
  tag?: string | null;
  bot?: boolean;
}

export interface ChatReaction {
  emoji: string;
  /** A custom emoji's picture. */
  url?: string | null;
  count?: number | null;
}

export interface ChatEmbed {
  title?: string | null;
  description?: string | null;
  /** Where the title leads. */
  url?: string | null;
  /** The bar on its left, #rrggbb: the card's own colour (the skin's default without one). */
  color?: string | null;
  /** A picture shown large under the text. */
  image?: string | null;
  /** A small picture at the card's top right. */
  thumbnail?: string | null;
}

export interface ChatMedia {
  kind: "image" | "video" | "audio" | "sticker" | "file";
  /** Loadable as it is (signed where needed). Without one, only its label shows. */
  url?: string | null;
  name?: string | null;
  bytes?: number | null;
  durationS?: number | null;
}

export type Skin = "whatsapp" | "discord" | "slack" | "gchat" | "transcript";

export interface SkinProps {
  /** Oldest first, as a conversation reads. */
  messages: ChatMessage[];
  /** The message's text as nodes: mentions, links. Default: the text as it is. */
  renderText?: (m: ChatMessage) => React.ReactNode;
  /** Open a picture or a file (through the host: `app.openLink`). */
  onOpen?: (url: string) => void;
  onThread?: (m: ChatMessage) => void;
  /** Above the first message, on the skin's background: "load earlier". */
  header?: React.ReactNode;
  /** Beside a message, on hover or focus: "reply". Null for none on that one. */
  actions?: (m: ChatMessage) => React.ReactNode;
  /** A message to mark for a moment (the one a search opened), by id. */
  highlight?: string | null;
}
