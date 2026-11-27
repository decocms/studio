/** What every skin shares: how messages group, and how media is drawn. */
import { BanIcon, FileIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Avatar as StudioAvatar } from "@decocms/ui/components/avatar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { ChatMedia, ChatMessage, SkinProps } from "./types.ts";

/**
 * A person's face: Studio's avatar (the picture, else the initials on the
 * name's colour), round for a person, `square` for a workspace or a server.
 * Sized by the skin's own `size-*` class.
 */
export function Avatar({
  name,
  src,
  className,
  square,
}: {
  name: string | null;
  src: string | null;
  className?: string;
  square?: boolean;
}) {
  return (
    <StudioAvatar
      fallback={name ?? "?"}
      url={src ?? undefined}
      shape={square ? "square" : "circle"}
      size="sm"
      className={cn(square && "rounded-[27%]", className)}
    />
  );
}

/** Who a message is from, for grouping and colour: the id, else the name. */
export const who = (m: ChatMessage) => m.author?.id ?? m.author?.name ?? "";

export type Item =
  | { type: "day"; key: string; label: string }
  | {
      type: "message";
      key: string;
      m: ChatMessage;
      /** Starts a run: the author's face and name show. */
      first: boolean;
    };

/**
 * The conversation as the apps lay it out: a divider where the day changes,
 * and runs of one author's messages (within `gapMs`) under one name.
 */
export function layout(
  messages: ChatMessage[],
  gapMs: number,
  /** How the channel names a day on its divider. */
  dayLabel: (iso: string) => string,
): Item[] {
  const out: Item[] = [];
  let prev: ChatMessage | undefined;
  let lastDay = "";
  for (const m of messages) {
    const d = m.ts ? dayLabel(m.ts) : "";
    if (d && d !== lastDay) {
      out.push({ type: "day", key: `day:${m.id}`, label: d });
      lastDay = d;
      prev = undefined;
    }
    const run =
      !!prev &&
      !m.system &&
      !prev.system &&
      who(prev) === who(m) &&
      !!m.ts &&
      !!prev.ts &&
      new Date(m.ts).getTime() - new Date(prev.ts).getTime() < gapMs;
    out.push({ type: "message", key: m.id, m, first: !run });
    prev = m;
  }
  return out;
}

/**
 * A skin's name colour (`--sk-n0`…`--sk-n7`), stable per name — the same for
 * a person's bubbles and for a quote of them.
 */
export function nameColor(
  m: { author?: { name: string | null } | null } | string | null,
) {
  const key = (typeof m === "string" ? m : m?.author?.name) ?? "";
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--sk-n${h % 8})`;
}

/** The body: what was said, or why it isn't shown. */
export function Body({
  m,
  renderText,
}: {
  m: ChatMessage;
  renderText?: SkinProps["renderText"];
}) {
  const t = useT();
  if (m.deleted)
    return (
      <span className="sk-muted inline-flex items-center gap-1 italic">
        <BanIcon className="size-3.5" />
        {t("channelSkins.deleted")}
      </span>
    );
  if (m.withheld && !m.text)
    return (
      <span className="sk-muted inline-flex items-center gap-1 italic">
        <LockIcon className="size-3.5" />
        {t("channelSkins.withheld")}
      </span>
    );
  if (!m.text) return null;
  return (
    <span className="break-words whitespace-pre-wrap">
      {renderText ? renderText(m) : m.text}
    </span>
  );
}

const size = (bytes?: number | null) =>
  !bytes
    ? ""
    : bytes < 1_048_576
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

const LABEL: Record<ChatMedia["kind"], TranslationKey> = {
  image: "channelSkins.media.image",
  video: "channelSkins.media.video",
  audio: "channelSkins.media.audio",
  sticker: "channelSkins.media.sticker",
  file: "channelSkins.media.file",
};

/**
 * A picture, a video, a voice note, a sticker or a file. Native players: they
 * are the ones people already know, on every platform. Without a URL (the
 * source kept only that there was one) it says what it was.
 */
export function Media({
  media,
  onOpen,
  className,
}: {
  media: ChatMedia;
  onOpen?: (url: string) => void;
  className?: string;
}) {
  const t = useT();
  const { kind, url, name } = media;
  if (!url)
    return (
      <span
        className={cn(
          "sk-muted flex items-center gap-1.5 text-[0.92em]",
          className,
        )}
      >
        <FileIcon className="size-3.5" />
        {name || t(LABEL[kind])}
        {media.bytes ? ` · ${size(media.bytes)}` : ""}
      </span>
    );
  if (kind === "image" || kind === "sticker")
    return (
      <button
        type="button"
        className={cn("focus-ring block", className)}
        onClick={() => onOpen?.(url)}
        aria-label={name || t(LABEL[kind])}
      >
        <img
          src={url}
          alt={name ?? ""}
          loading="lazy"
          className={cn(
            kind === "sticker"
              ? "size-32 object-contain"
              : "max-h-80 max-w-full rounded-[inherit] object-cover",
          )}
        />
      </button>
    );
  if (kind === "video")
    return (
      // biome-ignore lint/a11y/useMediaCaption: messages carry no captions.
      <video
        src={url}
        controls
        preload="metadata"
        className={cn("max-h-80 max-w-full rounded-[inherit]", className)}
      />
    );
  if (kind === "audio")
    return (
      // biome-ignore lint/a11y/useMediaCaption: voice notes carry no captions; the transcript, when there is one, is the message's text.
      <audio
        src={url}
        controls
        preload="none"
        className={cn("h-10 w-64 max-w-full", className)}
      />
    );
  return (
    <button
      type="button"
      onClick={() => onOpen?.(url)}
      className={cn(
        "sk-file focus-ring flex max-w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left",
        className,
      )}
    >
      <FileIcon className="size-5 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate">{name || t(LABEL.file)}</span>
        {media.bytes ? (
          <span className="sk-muted block text-[0.85em]">
            {size(media.bytes)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The reactions under a message: a chip each, with its count where there is one. */
export function Reactions({
  m,
  className,
  chip,
  counts,
}: {
  m: ChatMessage;
  className?: string;
  chip: string;
  /** Show a count of one too (Discord, Slack); WhatsApp shows it from two. */
  counts?: boolean;
}) {
  if (!m.reactions?.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {m.reactions.map((r) => (
        <span key={r.emoji} className={chip}>
          {r.url ? (
            <img src={r.url} alt={r.emoji} className="size-[1.15em]" />
          ) : (
            r.emoji
          )}
          {r.count && (counts || r.count > 1) ? (
            <span className="tnum">{r.count}</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export const Skinned = ({
  skin,
  className,
  children,
}: {
  skin: string;
  className?: string;
  children: ReactNode;
}) => (
  <div data-skin={skin} className={cn("sk min-h-full", className)}>
    {children}
  </div>
);
