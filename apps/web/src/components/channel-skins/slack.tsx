/**
 * Slack: flat rows. A 36px face with 8px corners 16px in from the edge, the
 * text 60px in; the name in black weight with "APP" and the time ("17h42")
 * small beside it; the same person's next messages under it, the time in
 * the gutter on hover; a notice ("entrou no canal") under the person's face
 * and name, quieter; reactions as rounded chips with a count; a thread as a
 * line of blue ("3 respostas"); the day ("Terça-feira, 27 de janeiro") as a
 * pill on a rule. Measured against Slack's web app (dark): skill
 * `channel-skins`.
 */
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useSkinFormat } from "./format.ts";
import { Avatar, Body, layout, Media, Reactions, Skinned } from "./parts.tsx";
import type { SkinProps } from "./types.ts";

/** Slack keeps a run going for a few minutes. */
const RUN = 5 * 60_000;

export function Slack({
  messages,
  renderText,
  onOpen,
  onThread,
  header,
  actions,
  highlight,
}: SkinProps) {
  const t = useT();
  const f = useSkinFormat();
  return (
    <Skinned skin="slack" className="pt-2 pb-5">
      {header}
      {layout(messages, RUN, f.longDay).map((it) => {
        if (it.type === "day")
          return (
            <div
              key={it.key}
              className="relative my-2 flex justify-center before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-[var(--sk-line)]"
            >
              <span className="sk-sl-day relative">{it.label}</span>
            </div>
          );
        const { m, first } = it;
        if (m.system && !m.author)
          return (
            <div key={it.key} className="sk-muted py-1 pr-4 pl-[60px]">
              {m.system}
            </div>
          );
        return (
          <div
            key={it.key}
            data-message-id={m.id}
            className={cn(
              "group/m relative py-1 pr-4 pl-[60px] transition-colors duration-700 hover:bg-[var(--sk-hover)]",
              highlight === m.id ? "bg-[var(--sk-hover)]" : null,
            )}
          >
            {actions?.(m) ? (
              <div className="absolute -top-3 right-4 z-10 rounded-lg border bg-[var(--sk-bg)] opacity-0 transition-opacity duration-150 group-hover/m:opacity-100 focus-within:opacity-100">
                {actions(m)}
              </div>
            ) : null}
            {first ? (
              <>
                <Avatar
                  name={m.author?.name ?? null}
                  src={m.author?.photo ?? null}
                  square
                  className="sk-sl-face absolute top-2 left-4 size-9"
                />
                <div className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="truncate font-black"
                    style={{ color: "var(--sk-head)" }}
                  >
                    {m.author?.name ?? "?"}
                  </span>
                  {m.author?.bot ? (
                    <span className="sk-sl-tag">APP</span>
                  ) : null}
                  {m.author?.tag ? (
                    <span className="sk-sl-time">{m.author.tag}</span>
                  ) : null}
                  <span className="sk-sl-time shrink-0">
                    {m.ts ? f.hourMin(m.ts) : ""}
                  </span>
                </div>
              </>
            ) : (
              <span className="sk-sl-time absolute top-1.5 left-0 hidden w-[52px] text-right group-hover/m:block">
                {m.ts ? f.hourMin(m.ts) : ""}
              </span>
            )}
            {m.system ? (
              <div className="sk-muted">{m.system}</div>
            ) : (
              <>
                {m.reply ? (
                  <div
                    className="sk-muted my-0.5 border-l-4 pl-2.5 text-[0.93em]"
                    style={{ borderColor: "var(--sk-line)" }}
                  >
                    <span className="font-bold">{m.reply.author}</span>{" "}
                    <span className="line-clamp-2">{m.reply.text}</span>
                  </div>
                ) : null}
                <Body m={m} renderText={renderText} />
                {m.edited && !m.deleted ? (
                  <span className="sk-muted ml-1 text-xs">
                    {t("channelSkins.editedParen")}
                  </span>
                ) : null}
              </>
            )}
            {m.media?.map((x, i) => (
              <Media
                // biome-ignore lint/suspicious/noArrayIndexKey: media has no id
                key={i}
                media={x}
                onOpen={onOpen}
                className="mt-1 rounded-lg"
              />
            ))}
            <Reactions
              m={m}
              counts
              className="mt-1"
              chip="flex items-center gap-1 rounded-full border border-[var(--sk-line)] bg-[var(--sk-chip)] px-2 py-0.5 text-[13px]"
            />
            {m.thread && onThread ? (
              <button
                type="button"
                onClick={() => onThread(m)}
                className="sk-link focus-ring mt-1 block rounded text-[13px] font-bold hover:underline"
              >
                {m.thread.count
                  ? m.thread.count === 1
                    ? t("channelSkins.repliesOne")
                    : t("channelSkins.replies", { count: m.thread.count })
                  : (m.thread.title ?? t("channelSkins.viewThread"))}
              </button>
            ) : null}
          </div>
        );
      })}
    </Skinned>
  );
}
