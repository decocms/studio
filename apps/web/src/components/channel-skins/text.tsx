/**
 * A message's text drawn the way chat apps draw it, never as raw markup:
 * Slack's mrkdwn (`*bold*`, `_italic_`, `~strike~`, `<url|label>`,
 * `<@U1|Ana>`), the markdown Slack's AI apps post (`**bold**`, `### title`,
 * tables, lists, code) and Google Chat's formatting (mrkdwn's inline set).
 * Blocks: paragraphs (line breaks kept), headings, lists (nested by
 * indentation), tables, quotes, code. React nodes, no HTML strings: nothing
 * in a message can inject markup. The look of each piece is the skin's
 * (`.sk-text` in chat.css).
 *
 * A mention arrives already named by the adapter (`<@U1|Ana>`): the id never
 * shows. A link opens through `open` (the host), never in this frame.
 */
import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";

export interface ChatTextProps {
  text: string;
  open?: (url: string) => void;
  /**
   * Markdown (`*x*` is italic, `**x**` bold) rather than mrkdwn (`*x*` is
   * bold). Default: told from the text itself (`isMarkdown`).
   */
  markdown?: boolean;
}

/** Markdown's own marks, which mrkdwn never writes. */
const isMarkdown = (text: string) =>
  /\*\*\S|^#{1,6}\s|^\s*\|.+\|\s*$|\]\(https?:\/\//m.test(text);

export function ChatText({ text, open, markdown }: ChatTextProps) {
  const t = useT();
  const md = markdown ?? isMarkdown(text);
  const words = {
    someone: t("channelSkins.someone"),
    channel: t("channelSkins.channel"),
    group: t("channelSkins.group"),
  };
  return <div className="sk-text">{blocks(text, { open, md, words })}</div>;
}

interface Ctx {
  open?: (url: string) => void;
  md: boolean;
  /** What a mention without its name reads as. */
  words: { someone: string; channel: string; group: string };
}

const LIST = /^(\s*)([-*•◦▪]|\d+[.)])\s+(.*)$/;
const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^(?:>|&gt;)\s?(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

function blocks(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  // Code first: nothing inside a fence is formatting.
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length - 1) {
      const code = ctx.md ? part.replace(/^[\w+-]*\n/, "") : part;
      out.push(
        <pre key={`pre${i}`}>{decode(code.replace(/^\n|\n$/g, ""))}</pre>,
      );
    } else lines(i % 2 === 1 ? `\`\`\`${part}` : part, ctx, `${i}:`, out);
  });
  return out;
}

function lines(text: string, ctx: Ctx, key: string, out: ReactNode[]) {
  const ls = text.split("\n");
  const line = (n: number) => ls[n] ?? "";
  let i = 0;
  const k = () => `${key}${i}`;
  while (i < ls.length) {
    const l = line(i);
    if (!l.trim()) {
      i++;
      continue;
    }
    const h = ctx.md ? l.match(HEADING) : null;
    if (h) {
      out.push(
        <div key={k()} className="sk-h">
          {inline(h[1] ?? "", ctx)}
        </div>,
      );
      i++;
      continue;
    }
    if (ROW.test(l) && RULE.test(line(i + 1))) {
      const at = k();
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < ls.length && ROW.test(line(i))) rows.push(cells(line(i++)));
      out.push(
        <div key={at} className="sk-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells have no id
                  <th key={j}>{inline(c, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
                <tr key={j}>
                  {head.map((_, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells have no id
                    <td key={c}>{inline(r[c] ?? "", ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST.test(l)) {
      const at = k();
      const items: Item[] = [];
      // A list goes on while its lines are items, or text indented under one.
      while (i < ls.length && line(i).trim()) {
        const m = line(i).match(LIST);
        if (m)
          items.push({
            indent: (m[1] ?? "").length,
            n: /\d/.test(m[2] ?? "") ? Number.parseInt(m[2] ?? "", 10) : null,
            text: m[3] ?? "",
          });
        else if (/^\s/.test(line(i)) && items.length)
          (items[items.length - 1] as Item).text += `\n${line(i).trim()}`;
        else break;
        i++;
      }
      out.push(list(items, ctx, at));
      continue;
    }
    if (QUOTE.test(l)) {
      const at = k();
      const q: string[] = [];
      while (i < ls.length && QUOTE.test(line(i)))
        q.push((line(i++).match(QUOTE) as RegExpMatchArray)[1] ?? "");
      out.push(<blockquote key={at}>{withBreaks(q, ctx)}</blockquote>);
      continue;
    }
    const at = k();
    const p: string[] = [];
    while (
      i < ls.length &&
      line(i).trim() &&
      !LIST.test(line(i)) &&
      !QUOTE.test(line(i)) &&
      !(ctx.md && HEADING.test(line(i))) &&
      !(ROW.test(line(i)) && RULE.test(line(i + 1)))
    )
      p.push(line(i++));
    out.push(<p key={at}>{withBreaks(p, ctx)}</p>);
  }
}

interface Item {
  indent: number;
  n: number | null;
  text: string;
}

/** Items one level deeper than the first become a list inside the item above. */
function list(items: Item[], ctx: Ctx, key: string): ReactNode {
  const base = items[0]?.indent ?? 0;
  const top: { item: Item; kids: Item[] }[] = [];
  for (const it of items)
    if (it.indent > base && top.length)
      (top[top.length - 1] as (typeof top)[number]).kids.push(it);
    else top.push({ item: it, kids: [] });
  const body = top.map(({ item, kids }, j) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: items have no id
    <li key={j}>
      {withBreaks(item.text.split("\n"), ctx)}
      {kids.length ? list(kids, ctx, `${key}.${j}`) : null}
    </li>
  ));
  const first = items[0]?.n ?? null;
  return first !== null ? (
    <ol key={key} start={first}>
      {body}
    </ol>
  ) : (
    <ul key={key}>{body}</ul>
  );
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function withBreaks(ls: string[], ctx: Ctx): ReactNode[] {
  return ls.flatMap((l, j) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id
    j ? [<br key={`br${j}`} />, ...inline(l, ctx, `${j}:`)] : inline(l, ctx),
  );
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/*
 * Inline marks, the leftmost first. A mark needs a word boundary outside it
 * and no space just inside, so "2 * 3 * 4" and snake_case stay as written;
 * an address is taken whole before any mark (a `*` inside a URL is the URL's).
 */
const TOKEN = new RegExp(
  [
    /`(?<code>[^`\n]+)`/,
    /<(?<entity>(?:[@#!]|https?:\/\/|mailto:|tel:)[^<>\s|][^<>]*)>/,
    /\[(?<label>[^\]\n]+)\]\((?<href>https?:\/\/[^)\s]+)\)/,
    /(?<url>https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]])/,
    /\*\*(?=\S)(?<strong>[^\n]*?\S)\*\*/,
    /~~(?=\S)(?<del>[^\n]*?\S)~~/,
    /(?<![\w*])\*(?=\S)(?<star>[^*\n]*\S)\*(?![\w*])/,
    /(?<![\w_])_(?=\S)(?<em>[^_\n]*\S)_(?![\w_])/,
    /(?<![\w~])~(?=\S)(?<strike>[^~\n]*\S)~(?![\w~])/,
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
);

function inline(text: string, ctx: Ctx, prefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > at) out.push(decode(text.slice(at, i)));
    const g = m.groups ?? {};
    const key = `${prefix}${i}`;
    if (g.code) out.push(<code key={key}>{decode(g.code)}</code>);
    else if (g.entity) out.push(entity(g.entity, ctx, key));
    else if (g.label && g.href)
      out.push(link(g.href, inline(g.label, ctx, `${key}:`), ctx, key));
    else if (g.url) out.push(link(g.url, g.url, ctx, key));
    else if (g.strong)
      out.push(<strong key={key}>{inline(g.strong, ctx, `${key}:`)}</strong>);
    else if (g.star)
      out.push(
        ctx.md ? (
          <em key={key}>{inline(g.star, ctx, `${key}:`)}</em>
        ) : (
          <strong key={key}>{inline(g.star, ctx, `${key}:`)}</strong>
        ),
      );
    else if (g.em) out.push(<em key={key}>{inline(g.em, ctx, `${key}:`)}</em>);
    else if (g.del || g.strike)
      out.push(
        <s key={key}>{inline(g.del || g.strike || "", ctx, `${key}:`)}</s>,
      );
    at = i + m[0].length;
  }
  if (at < text.length) out.push(decode(text.slice(at)));
  return out;
}

/** Slack's `<…>`: a person, a channel, a broadcast, a date, or a link. */
function entity(raw: string, ctx: Ctx, key: string): ReactNode {
  const bar = raw.indexOf("|");
  const target = bar < 0 ? raw : raw.slice(0, bar);
  const label = bar < 0 ? null : decode(raw.slice(bar + 1));
  const mention = (s: string) => (
    <span key={key} className="sk-mention">
      {s}
    </span>
  );
  if (target.startsWith("@")) return mention(`@${label || ctx.words.someone}`);
  if (target.startsWith("#")) return mention(`#${label || ctx.words.channel}`);
  if (target.startsWith("!date")) return label ?? "";
  if (target.startsWith("!subteam"))
    return mention(label || `@${ctx.words.group}`);
  if (target.startsWith("!")) return mention(`@${target.slice(1)}`);
  return link(target, label || target.replace(/^(mailto|tel):/, ""), ctx, key);
}

function link(url: string, label: ReactNode, ctx: Ctx, key: string): ReactNode {
  return (
    <a
      key={key}
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!ctx.open) return;
        e.preventDefault();
        ctx.open(url);
      }}
    >
      {label}
    </a>
  );
}
