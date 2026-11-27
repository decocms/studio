/**
 * Google Chat (comfortable density, the default since the 2023 bubbles):
 * others on the left in a grey bubble, their 32px face 16px off it, level
 * with the run's first bubble, and "name time" above the run in line with
 * the text; ours on the right in the tinted bubble with only the time; the
 * bubbles of one run 2px apart, hugging (4px corners) on the speaker's side;
 * the time says the day ("Ontem 16:04", "seg. 10:57") and " • Editada"
 * follows it; a quote is a sheet of the background at the top of the
 * bubble, with a quote mark and the quoted name; notices as plain centred
 * text; reactions as chips with a count; a thread's replies folded under its
 * first message ("2 respostas"). Measured against Google Chat's web app
 * (light): skill `channel-skins`.
 */
import { QuoteIcon } from "lucide-react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useSkinFormat } from "./format.ts";
import {
  Avatar,
  Body,
  layout,
  Media,
  Reactions,
  Skinned,
  who,
} from "./parts.tsx";
import type { SkinProps } from "./types.ts";

const RUN = 7 * 60_000;

const Notice = ({ children }: { children: React.ReactNode }) => (
  <div className="sk-muted my-3 text-center text-xs">{children}</div>
);

export function GChat({
  messages,
  renderText,
  onOpen,
  onThread,
  header,
  actions,
  highlight,
}: SkinProps) {
  // A conversation with one other person (a DM) shows no faces or names.
  const others = new Set(messages.filter((m) => !m.mine).map(who));
  const faces = others.size > 1 || !messages.some((m) => m.mine);
  const t = useT();
  const f = useSkinFormat();
  const items = layout(messages, RUN, f.day);
  return (
    <Skinned skin="gchat" className="px-4 py-3">
      {header}
      {items.map((it, i) => {
        if (it.type === "day") return <Notice key={it.key}>{it.label}</Notice>;
        const { m, first } = it;
        if (m.system) return <Notice key={it.key}>{m.system}</Notice>;
        const next = items[i + 1];
        const last = !(next?.type === "message" && !next.first);
        const action = actions?.(m);
        return (
          <div
            key={it.key}
            data-message-id={m.id}
            className={cn(
              "group/m flex gap-4 rounded-lg transition-colors duration-700",
              first ? "mt-3" : "mt-0.5",
              m.mine ? "flex-row-reverse" : null,
              highlight === m.id ? "bg-[var(--sk-hover)]" : null,
            )}
          >
            {m.mine || !faces ? null : (
              <div className="w-8 shrink-0">
                {first ? (
                  <Avatar
                    name={m.author?.name ?? null}
                    src={m.author?.photo ?? null}
                    className="mt-[18px] size-8"
                  />
                ) : null}
              </div>
            )}
            <div
              className={cn(
                "flex max-w-[min(75%,36rem)] min-w-0 flex-col",
                m.mine ? "items-end" : "items-start",
              )}
            >
              {first || (m.edited && !m.deleted) ? (
                <div className="sk-gc-meta mb-0.5 flex max-w-full items-baseline gap-2 px-3">
                  {m.mine || !faces || !first ? null : (
                    <span className="sk-gc-name truncate">
                      {m.author?.name ?? t("channelSkins.someone")}
                    </span>
                  )}
                  {!first ? null : m.author?.bot ? (
                    <span className="sk-gc-app">App</span>
                  ) : m.author?.tag && !m.mine ? (
                    <span>{m.author.tag}</span>
                  ) : null}
                  <span className="shrink-0">
                    {m.ts ? f.chatStamp(m.ts) : ""}
                    {m.edited && !m.deleted
                      ? ` • ${t("channelSkins.edited")}`
                      : ""}
                  </span>
                </div>
              ) : null}
              <div
                className={cn(
                  "sk-gc-bubble max-w-full",
                  m.mine ? "sk-gc-out" : "sk-gc-in",
                  first ? null : "sk-gc-after",
                  last ? null : "sk-gc-before",
                )}
              >
                {m.reply ? (
                  <div className="sk-gc-quote">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <QuoteIcon
                        aria-hidden
                        strokeWidth={0}
                        className="sk-gc-quote-mark size-3.5 shrink-0 rotate-180 fill-current"
                      />
                      {m.reply.author ? (
                        <span className="sk-gc-name truncate">
                          {m.reply.author}
                        </span>
                      ) : null}
                    </div>
                    <div className="line-clamp-2 break-words">
                      {m.reply.text}
                    </div>
                  </div>
                ) : null}
                <div className="px-3 py-2">
                  {m.media?.map((x, k) => (
                    <Media
                      // biome-ignore lint/suspicious/noArrayIndexKey: media has no id
                      key={k}
                      media={x}
                      onOpen={onOpen}
                      className="mb-1 rounded-xl"
                    />
                  ))}
                  <Body m={m} renderText={renderText} />
                </div>
              </div>
              <Reactions
                m={m}
                counts
                className="mt-1"
                chip="sk-gc-chip flex items-center gap-1 rounded-full px-2 py-0.5"
              />
              {m.thread ? (
                <button
                  type="button"
                  onClick={() => onThread?.(m)}
                  disabled={!onThread}
                  className="sk-link focus-ring mt-1 rounded px-1 text-xs font-medium enabled:hover:underline"
                >
                  {m.thread.count
                    ? m.thread.count === 1
                      ? t("channelSkins.repliesOne")
                      : t("channelSkins.replies", { count: m.thread.count })
                    : (m.thread.title ?? t("channelSkins.viewThread"))}
                </button>
              ) : null}
            </div>
            {action ? (
              <div className="self-center opacity-0 transition-opacity duration-150 group-hover/m:opacity-100 focus-within:opacity-100">
                {action}
              </div>
            ) : null}
          </div>
        );
      })}
    </Skinned>
  );
}
