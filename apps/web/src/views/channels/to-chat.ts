/**
 * CHANNELS_MESSAGE_LIST rows as the skins' `ChatMessage`. All the knowledge
 * of the row's fields lives here (skill `channel-skins`: an adapter per data
 * source); the skins never see a row.
 *
 * What Studio keeps of a message is what the ingestion route accepts: no
 * reactions, no pictures of people, attachments as `{ name, type, size, url }`
 * (or what a worker's mirror wrote), and nothing that says which side is ours,
 * so every message sits on the others' side.
 */
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import type {
  ChatMedia,
  ChatMessage,
} from "@/components/channel-skins/index.tsx";

export type MessageRow =
  StudioToolIO["CHANNELS_MESSAGE_LIST"]["output"]["messages"][number];

/** A WhatsApp id that is a phone: "5511…", "5511…@s.whatsapp.net", "5511…@c.us". */
const PHONE = /^\+?(\d{8,15})(@s\.whatsapp\.net|@c\.us)?$/;

const phoneOf = (id: string | null) => {
  const m = id ? PHONE.exec(id) : null;
  return m ? `+${m[1]}` : null;
};

/** An attachment as a worker sent it → one media, told by its kind or mime type. */
export function toMedia(value: unknown): ChatMedia[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((a) => {
    const x = (a ?? {}) as Record<string, unknown>;
    const str = (...keys: string[]) =>
      keys.map((k) => x[k]).find((v) => typeof v === "string") as
        | string
        | undefined;
    const num = (...keys: string[]) =>
      keys.map((k) => x[k]).find((v) => typeof v === "number") as
        | number
        | undefined;
    const type = `${str("kind", "type") ?? ""} ${str("mimetype", "content_type", "mime") ?? ""}`;
    const kind: ChatMedia["kind"] = /sticker/.test(type)
      ? "sticker"
      : /image/.test(type)
        ? "image"
        : /video/.test(type)
          ? "video"
          : /audio|voice|ptt/.test(type)
            ? "audio"
            : "file";
    return {
      kind,
      url: str("url") ?? null,
      name: str("name", "file_name", "filename") ?? null,
      bytes: num("size", "bytes") ?? null,
      durationS: num("duration_s") ?? null,
    };
  });
}

/** `rows` newest first, as the tool returns them → oldest first, as a conversation reads. */
export function toChat(rows: MessageRow[]): ChatMessage[] {
  const byId = new Map(rows.map((m) => [m.id, m] as const));
  const nameOf = (m: MessageRow) =>
    m.author_name ?? phoneOf(m.author_id) ?? m.author_id;
  return [...rows].reverse().map((m) => {
    // The message a reply points to, when it is among the ones loaded.
    const quoted = m.reply_to ? byId.get(m.reply_to) : undefined;
    const who = m.author_id ?? m.author_name;
    const phone = phoneOf(m.author_id);
    return {
      id: m.id,
      ts: m.ts,
      author: who
        ? {
            id: who,
            name: nameOf(m),
            // Beside a name, the number it came from (WhatsApp shows it).
            handle: m.author_name && phone ? phone : null,
          }
        : null,
      // A voice note's transcript is its text; beside a caption it goes under it.
      text: m.text ?? m.derived_text,
      note: m.text ? m.derived_text : null,
      deleted: !!m.deleted_at,
      edited: !!m.edited_at,
      reply: quoted
        ? {
            author: nameOf(quoted),
            text: quoted.text ?? quoted.derived_text,
          }
        : null,
      media: toMedia(m.attachments),
      offsetMs: m.offset_ms,
    };
  });
}
