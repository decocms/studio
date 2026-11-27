/**
 * Discord: a flat log. A 40px round face, the name and "Hoje às 21:27" on one
 * line, the same person's next messages tucked under without them (their
 * time shows in the gutter on hover), a reply as a line above with its
 * spine, embeds as a card with a bar on the left, reactions as chips with a
 * count, a thread as a box, the day as a rule with its date in the middle,
 * the actions floating at the top right of the row under the pointer.
 * Reference: skill `channel-skins`.
 */
import { ExternalLinkIcon } from "lucide-react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { type SkinFormat, useSkinFormat } from "./format.ts";
import { Avatar, Body, layout, Media, Reactions, Skinned } from "./parts.tsx";
import type { ChatMessage, SkinProps } from "./types.ts";

/** Discord starts a new header after seven minutes. */
const RUN = 7 * 60_000;

/** As Discord writes it beside the name: "Hoje às 21:27", else the date and time. */
function when(f: SkinFormat, at: string, ts: string) {
  const d = f.day(ts);
  return d === f.today || d === f.yesterday
    ? `${d} ${at} ${f.time(ts)}`
    : `${f.date(ts)} ${f.time(ts)}`;
}

function Embeds({
  m,
  onOpen,
  renderText,
}: {
  m: ChatMessage;
  onOpen?: (url: string) => void;
  /** The page's text renderer (mentions, markdown), for the card's body too. */
  renderText?: SkinProps["renderText"];
}) {
  if (!m.embeds?.length) return null;
  return m.embeds.map((e) => (
    <div
      key={`${e.url ?? ""}|${e.title ?? ""}|${e.description ?? ""}`}
      className="sk-dc-embed mt-1 grid max-w-[520px] grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded px-3 py-2 text-sm"
      // The card's own colour is data (what the bot sent), not a theme colour.
      style={e.color ? { borderLeftColor: e.color } : undefined}
    >
      <div className="min-w-0">
        {e.title ? (
          e.url && onOpen ? (
            <button
              type="button"
              className="sk-link focus-ring block text-left font-semibold hover:underline"
              onClick={() => onOpen(e.url as string)}
            >
              {e.title}
            </button>
          ) : (
            <div className="font-semibold" style={{ color: "var(--sk-head)" }}>
              {e.title}
            </div>
          )
        ) : null}
        {e.description ? (
          <div className="mt-0.5 line-clamp-6 break-words whitespace-pre-wrap">
            {renderText
              ? renderText({ ...m, text: e.description })
              : e.description}
          </div>
        ) : null}
      </div>
      {e.thumbnail ? (
        <img
          src={e.thumbnail}
          alt=""
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
          className="size-20 rounded object-cover"
        />
      ) : null}
      {e.image ? (
        <img
          src={e.image}
          alt=""
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
          className="col-span-2 mt-3 max-h-[300px] w-full rounded object-cover"
        />
      ) : null}
    </div>
  ));
}

/** Link buttons under a message, in one row, as Discord draws them. */
function Buttons({
  m,
  onOpen,
}: {
  m: ChatMessage;
  onOpen?: (url: string) => void;
}) {
  if (!m.buttons?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {m.buttons.map((b) => (
        <button
          key={`${b.label}|${b.url}`}
          type="button"
          onClick={() => onOpen?.(b.url)}
          className="sk-dc-button focus-ring flex h-8 items-center gap-1.5 rounded px-4 text-sm font-medium"
        >
          {b.label}
          <ExternalLinkIcon className="size-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

export function Discord({
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
    <Skinned skin="discord" className="pt-2 pb-6">
      {header}
      {layout(messages, RUN, f.day).map((it) => {
        if (it.type === "day")
          return (
            <div
              key={it.key}
              className="sk-muted mx-4 mt-6 mb-2 flex items-center gap-2 text-xs font-semibold before:h-px before:flex-1 before:bg-[var(--sk-line)] after:h-px after:flex-1 after:bg-[var(--sk-line)]"
            >
              {it.label}
            </div>
          );
        const { m } = it;
        if (m.system)
          return (
            <div
              key={it.key}
              data-message-id={m.id}
              className="sk-muted mt-[17px] px-4 py-0.5 pl-[72px] text-sm"
            >
              {m.system}
            </div>
          );
        // A reply always shows who is answering, even mid-run.
        const first = it.first || !!m.reply;
        const tools = actions?.(m);
        return (
          <div
            key={it.key}
            data-message-id={m.id}
            className={cn(
              "group/m relative px-4 py-0.5 pl-[72px] transition-colors duration-700 hover:bg-[var(--sk-hover)]",
              first ? "mt-[17px]" : null,
              highlight === m.id ? "bg-[var(--sk-mention)]" : null,
            )}
          >
            {m.reply ? (
              <div className="sk-muted sk-dc-spine relative mb-1 flex items-center gap-1.5 text-sm">
                <Avatar name={m.reply.author} src={null} className="size-4" />
                <span className="shrink-0 font-medium opacity-90">
                  @{m.reply.author ?? "?"}
                </span>
                <span className="truncate">{m.reply.text}</span>
              </div>
            ) : null}
            {first ? (
              <>
                <Avatar
                  name={m.author?.name ?? null}
                  src={m.author?.photo ?? null}
                  className={cn(
                    "absolute left-4 size-10",
                    m.reply ? "top-7" : "top-1",
                  )}
                />
                <div className="flex items-baseline gap-1">
                  <span
                    className="font-medium"
                    style={{ color: "var(--sk-head)" }}
                  >
                    {m.author?.name ?? "?"}
                  </span>
                  {m.author?.bot ? (
                    <span className="sk-dc-app self-center">APP</span>
                  ) : null}
                  {m.author?.tag ? (
                    <span className="sk-muted text-xs">{m.author.tag}</span>
                  ) : null}
                  <span className="sk-muted ml-1 text-xs">
                    {m.ts ? when(f, t("channelSkins.at"), m.ts) : ""}
                  </span>
                </div>
              </>
            ) : (
              <span className="sk-muted absolute top-1.5 left-0 hidden w-[60px] text-right text-[11px] group-hover/m:block">
                {m.ts ? f.time(m.ts) : ""}
              </span>
            )}
            <Body m={m} renderText={renderText} />
            {m.edited && !m.deleted ? (
              <span className="sk-muted ml-1 text-[10px]">
                {t("channelSkins.editedParen")}
              </span>
            ) : null}
            {m.media?.map((x, i) => (
              <Media
                // biome-ignore lint/suspicious/noArrayIndexKey: media has no id
                key={i}
                media={x}
                onOpen={onOpen}
                className="mt-1 max-w-[min(100%,550px)] rounded-lg"
              />
            ))}
            <Embeds m={m} onOpen={onOpen} renderText={renderText} />
            <Buttons m={m} onOpen={onOpen} />
            {m.thread ? (
              <button
                type="button"
                onClick={() => onThread?.(m)}
                className="focus-ring mt-1 flex max-w-sm items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm"
                style={{
                  backgroundColor: "var(--sk-chip)",
                  borderColor: "var(--sk-line)",
                }}
              >
                <span
                  className="truncate font-medium"
                  style={{ color: "var(--sk-head)" }}
                >
                  {m.thread.title || t("channelSkins.thread")}
                </span>
                <span className="sk-link shrink-0 font-semibold">
                  {m.thread.count
                    ? `${m.thread.count === 1 ? t("channelSkins.messagesOne") : t("channelSkins.messages", { count: m.thread.count })} ›`
                    : `${t("channelSkins.open")} ›`}
                </span>
              </button>
            ) : null}
            <Reactions
              m={m}
              counts
              className="mt-1"
              chip="flex items-center gap-1.5 rounded-lg border border-[var(--sk-line)] bg-[var(--sk-chip)] px-1.5 py-0.5 text-sm"
            />
            {tools ? (
              <div className="sk-dc-tools absolute -top-4 right-4 flex rounded-md p-0.5 opacity-0 transition-opacity duration-150 group-hover/m:opacity-100 focus-within:opacity-100">
                {tools}
              </div>
            ) : null}
          </div>
        );
      })}
    </Skinned>
  );
}
