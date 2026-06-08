import { useRef, useState } from "react";
import { cn } from "@deco/ui/lib/utils.js";
import { FloatingToolbar, InlineText, ToolbarButton } from "./primitives";

const HEADING_LEVELS = ["1", "2", "3"] as const;

const HEADING_CLASS: Record<string, string> = {
  "1": "text-3xl font-bold",
  "2": "text-2xl font-bold",
  "3": "text-xl font-semibold",
  "4": "text-lg font-semibold",
  "5": "text-base font-semibold",
  "6": "text-sm font-semibold",
};

export function HeadingBlock({
  text,
  level,
  onChange,
}: {
  text: string;
  level: string;
  onChange: (next: { text: string; level: string }) => void;
}) {
  const [focused, setFocused] = useState(false);
  const lvl = level || "2";

  return (
    <div className="relative">
      {focused && (
        <FloatingToolbar>
          {HEADING_LEVELS.map((l) => (
            <ToolbarButton
              key={l}
              active={lvl === l}
              label={`Heading ${l}`}
              onClick={() => onChange({ text, level: l })}
            >
              H{l}
            </ToolbarButton>
          ))}
        </FloatingToolbar>
      )}
      <InlineText
        value={text}
        onChange={(v) => onChange({ text: v, level: lvl })}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Heading"
        className={cn(
          "text-foreground",
          HEADING_CLASS[lvl] ?? HEADING_CLASS["2"],
        )}
      />
    </div>
  );
}

export function QuoteBlock({
  quote,
  onChange,
}: {
  quote: string;
  onChange: (quote: string) => void;
}) {
  return (
    <div className="border-l-2 border-foreground/30 pl-4">
      <InlineText
        value={quote}
        onChange={onChange}
        placeholder="Quote"
        className="text-lg italic text-foreground/90"
      />
    </div>
  );
}

export function CodeBlock({
  code,
  language,
  onChange,
}: {
  code: string;
  language: string;
  onChange: (next: { code: string; language: string }) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border bg-muted/50">
      <input
        value={language}
        onChange={(e) => onChange({ code, language: e.target.value })}
        placeholder="language"
        className="w-full border-b bg-transparent px-3 py-1.5 font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
      />
      <InlineText
        value={code}
        onChange={(v) => onChange({ code: v, language })}
        placeholder="Code"
        spellCheck={false}
        className="px-3 py-2.5 font-mono text-sm text-foreground"
      />
    </div>
  );
}

/**
 * List block. Deco stores items as a newline-separated string plus a
 * `style` (ordered/unordered). Each item is a wrapping, inline-editable
 * row: Enter adds the next item (and moves the caret there), Backspace on
 * an empty row removes it, and Up/Down move between items at the edges.
 */
export function ListBlock({
  items,
  style,
  onChange,
}: {
  items: string;
  style: string;
  onChange: (next: { items: string; style: string }) => void;
}) {
  const ordered = style === "ordered";
  const rows = items.length ? items.split("\n") : [""];
  const [focused, setFocused] = useState(false);
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const commit = (nextRows: string[]) =>
    onChange({ items: nextRows.join("\n"), style });

  const focusRow = (i: number, caret: "start" | "end") =>
    requestAnimationFrame(() => {
      const el = refs.current[i];
      if (!el) return;
      el.focus();
      const pos = caret === "end" ? el.value.length : 0;
      el.setSelectionRange(pos, pos);
    });

  return (
    <div
      className="relative"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      {focused && (
        <FloatingToolbar>
          <ToolbarButton
            active={!ordered}
            label="Bulleted"
            onClick={() => onChange({ items, style: "unordered" })}
          >
            •
          </ToolbarButton>
          <ToolbarButton
            active={ordered}
            label="Numbered"
            onClick={() => onChange({ items, style: "ordered" })}
          >
            1.
          </ToolbarButton>
        </FloatingToolbar>
      )}
      <ul className="space-y-1">
        {rows.map((row, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="min-w-5 shrink-0 select-none pt-px text-right text-[15px] leading-relaxed text-muted-foreground tabular-nums">
              {ordered ? `${i + 1}.` : "•"}
            </span>
            <InlineText
              inputRef={(el) => {
                refs.current[i] = el;
              }}
              value={row}
              onChange={(value) => {
                const next = [...rows];
                next[i] = value;
                commit(next);
              }}
              onKeyDown={(e) => {
                const el = e.currentTarget;
                if (e.key === "Enter") {
                  e.preventDefault();
                  const next = [...rows];
                  next.splice(i + 1, 0, "");
                  commit(next);
                  focusRow(i + 1, "start");
                } else if (
                  e.key === "Backspace" &&
                  row === "" &&
                  rows.length > 1
                ) {
                  e.preventDefault();
                  commit(rows.filter((_, idx) => idx !== i));
                  focusRow(Math.max(0, i - 1), "end");
                } else if (
                  e.key === "ArrowUp" &&
                  el.selectionStart === 0 &&
                  i > 0
                ) {
                  e.preventDefault();
                  focusRow(i - 1, "end");
                } else if (
                  e.key === "ArrowDown" &&
                  el.selectionEnd === row.length &&
                  i < rows.length - 1
                ) {
                  e.preventDefault();
                  focusRow(i + 1, "end");
                }
              }}
              placeholder="List item"
              className="text-[15px] leading-relaxed text-foreground"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
