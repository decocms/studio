/**
 * A channel's mark: its logo, white on a tile of its one colour, the same as
 * the channels hub draws it. Brand colours are data here (the one place a raw
 * colour is allowed), not theme tokens. A source without a mark gets a muted
 * tile with its initial.
 */
import { cn } from "@decocms/ui/lib/utils.ts";
import { MessageChatSquare, VideoRecorder } from "@untitledui/icons";
import type { ReactNode } from "react";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { channelName } from "@/lib/channel-accounts";

/** simple-icons paths (CC0), as the hub's channel-logo uses them. */
const path = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
    className="size-[62%]"
  >
    <path d={d} />
  </svg>
);

const MARKS: Record<string, { color: string; glyph: ReactNode }> = {
  whatsapp: {
    color: "#25d366",
    glyph: path(
      "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
    ),
  },
  discord: {
    color: "#5865f2",
    glyph: <DiscordIcon className="size-[62%]" />,
  },
  slack: {
    color: "#4a154b",
    glyph: path(
      "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    ),
  },
  gchat: {
    color: "#00ac47",
    glyph: path(
      "M1.637 0C.733 0 0 .733 0 1.637v16.5c0 .904.733 1.636 1.637 1.636h3.955v3.323c0 .804.97 1.207 1.539.638l3.963-3.96h11.27c.903 0 1.636-.733 1.636-1.637V5.592L18.408 0Zm3.955 5.592h12.816v8.59H8.455l-2.863 2.863Z",
    ),
  },
  // Grain has no public mark: a camera on its green.
  grain: { color: "#00a86b", glyph: <VideoRecorder className="size-[62%]" /> },
  teams: {
    color: "#5059c9",
    glyph: <MessageChatSquare className="size-[62%]" />,
  },
};

export function ChannelMark({
  source,
  className,
}: {
  source: string;
  /** Size with `size-*` (default size-8). */
  className?: string;
}) {
  const mark = MARKS[source];
  return (
    <span
      role="img"
      aria-label={channelName(source)}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[27%] bg-muted text-muted-foreground",
        mark && "text-white",
        className,
      )}
      style={mark ? { backgroundColor: mark.color } : undefined}
    >
      {mark?.glyph ?? (
        <span className="text-xs font-medium">
          {source.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}
