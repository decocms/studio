/**
 * WhatsApp: bubbles on the doodle wallpaper, ours on the right in green, a
 * tail on the first bubble of a run, the sender's name in their colour with
 * the number beside it, the quote with a bar in the quoted person's colour,
 * the time tucked into the bubble's corner, reactions hanging from it.
 * Reference and rules: skill `channel-skins`, references/whatsapp.md.
 */
import { ForwardIcon } from "lucide-react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useSkinFormat } from "./format.ts";
import {
  Avatar,
  Body,
  layout,
  Media,
  nameColor,
  Reactions,
  Skinned,
} from "./parts.tsx";
import type { SkinProps } from "./types.ts";

/** WhatsApp groups a person's messages however far apart, within the day. */
const RUN = 24 * 3_600_000;

const Pill = ({ children }: { children: React.ReactNode }) => (
  <div className="my-2.5 flex justify-center">
    <span
      className="sk-muted rounded-lg px-3 py-1 text-[12.5px] shadow-[0_1px_0.5px_#0b141a21]"
      style={{ backgroundColor: "var(--sk-pill)" }}
    >
      {children}
    </span>
  </div>
);

export function WhatsApp({
  messages,
  renderText,
  onOpen,
  header,
  actions,
  highlight,
}: SkinProps) {
  // A chat with one other person shows no faces or names, like the app: only
  // where someone other than us has a name does the gutter exist.
  const faces = messages.some((m) => !m.mine && m.author?.name);
  const t = useT();
  const f = useSkinFormat();
  return (
    <Skinned skin="whatsapp" className="px-[5%] py-3">
      {header}
      {layout(messages, RUN, f.day).map((it) => {
        if (it.type === "day") return <Pill key={it.key}>{it.label}</Pill>;
        const { m, first } = it;
        if (m.system) return <Pill key={it.key}>{m.system}</Pill>;
        // A sticker stands alone, without a bubble — when there is one to show.
        const sticker =
          m.media?.length === 1 &&
          m.media[0]?.kind === "sticker" &&
          !!m.media[0]?.url &&
          !m.text;
        const visual = m.media?.some(
          (x) => x.url && (x.kind === "image" || x.kind === "video"),
        );
        return (
          <div
            key={it.key}
            data-message-id={m.id}
            className={cn(
              "group/m flex gap-2 rounded-lg transition-colors duration-700",
              first ? "mt-3" : "mt-0.5",
              m.mine ? "flex-row-reverse" : null,
              m.reactions?.length ? "mb-5" : null,
              highlight === m.id ? "bg-[var(--sk-hover)]" : null,
            )}
          >
            {m.mine || !faces ? null : (
              <div className="w-7 shrink-0">
                {first && m.author?.name ? (
                  <Avatar
                    name={m.author?.name ?? null}
                    src={m.author?.photo ?? null}
                    className="size-7"
                  />
                ) : null}
              </div>
            )}
            <div
              className={cn(
                "sk-wa-bubble max-w-[min(75%,34rem)] min-w-0",
                sticker ? "shadow-none" : "px-[9px] pt-1.5 pb-2",
                first && !sticker
                  ? m.mine
                    ? "sk-wa-tail-out"
                    : "sk-wa-tail-in"
                  : null,
              )}
              style={
                sticker
                  ? undefined
                  : { backgroundColor: `var(--sk-${m.mine ? "out" : "in"})` }
              }
            >
              {first && !m.mine && !sticker && m.author?.name ? (
                <div className="flex items-baseline justify-between gap-4 text-[12.8px] leading-[22px] font-medium">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate" style={{ color: nameColor(m) }}>
                      ~ {m.author.name}
                    </span>
                    {m.author?.tag ? (
                      <span className="sk-wa-meta shrink-0 font-normal">
                        {m.author.tag}
                      </span>
                    ) : null}
                  </span>
                  {m.author?.handle ? (
                    <span className="sk-wa-meta shrink-0">
                      {m.author.handle}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {m.forwarded ? (
                <div className="sk-wa-meta flex items-center gap-1 italic">
                  <ForwardIcon className="size-3.5" />
                  {t("channelSkins.forwarded")}
                </div>
              ) : null}
              {m.reply ? (
                <div
                  className="mb-1 overflow-hidden rounded-[7px] border-l-4 px-2.5 py-1.5 text-[12.8px]"
                  style={{
                    backgroundColor: "var(--sk-chip)",
                    borderColor: nameColor(m.reply.author),
                  }}
                >
                  {m.reply.author ? (
                    <div
                      className="font-medium"
                      style={{ color: nameColor(m.reply.author) }}
                    >
                      ~ {m.reply.author}
                    </div>
                  ) : null}
                  <div className="sk-muted line-clamp-3 break-words">
                    {m.reply.text}
                  </div>
                </div>
              ) : null}
              {m.media?.map((x, i) => (
                <Media
                  // biome-ignore lint/suspicious/noArrayIndexKey: media has no id
                  key={i}
                  media={x}
                  onOpen={onOpen}
                  className={cn(
                    "rounded-md",
                    visual ? "-mx-1.5 mb-1 first:-mt-0.5" : "mb-1",
                  )}
                />
              ))}
              <Body m={m} renderText={renderText} />
              {m.note ? (
                <div
                  className="sk-muted mt-1 border-t border-dashed pt-1 text-[12.8px] break-words whitespace-pre-wrap"
                  style={{ borderColor: "var(--sk-line)" }}
                >
                  {m.note}
                </div>
              ) : null}
              {sticker ? null : (
                <span className="sk-wa-meta float-right mt-2 -mb-1.5 ml-3">
                  {m.edited ? `${t("channelSkins.edited")} ` : ""}
                  {m.ts ? f.time(m.ts) : ""}
                </span>
              )}
              <Reactions
                m={m}
                className="absolute -bottom-[18px] left-2"
                chip="flex items-center gap-1 rounded-full px-1.5 py-px text-[13px] leading-5 shadow-[0_0_0_2px_var(--sk-bg)] bg-[var(--sk-in)]"
              />
            </div>
            {actions?.(m) ? (
              <div className="self-center opacity-0 transition-opacity duration-150 group-hover/m:opacity-100 focus-within:opacity-100">
                {actions(m)}
              </div>
            ) : null}
          </div>
        );
      })}
    </Skinned>
  );
}
