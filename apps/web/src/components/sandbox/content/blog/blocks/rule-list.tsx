/**
 * The two list editors the blog's context screens share.
 *
 * Both started inside `context.tsx`, where the brand form was their only
 * caller. The campaign editor needs the same two — its guardrails are
 * `{ name, value }` rules and its keywords are plain terms — and duplicating
 * them would mean maintaining the citation parsing and the warning debounce in
 * two places.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  MarkdownEditor,
  type MarkdownMentions,
} from "@/components/markdown-editor";
import { AddButton, RemoveButton } from "./primitives";
import type { BrandRule } from "../blog-data";

/**
 * A list of plain terms, as chips.
 *
 * Keywords have no body to write, and a column of one-field rows reads as a
 * form with a missing half. Chips also make the list scannable at the length
 * this field actually reaches, which is twenty terms, not three.
 */
export function TermsInput({
  terms,
  onChange,
  placeholder,
  removeLabel,
}: {
  terms: string[];
  onChange: (terms: string[]) => void;
  placeholder: string;
  removeLabel: string;
}) {
  const [draft, setDraft] = useState("");

  /** Commits whatever is typed, splitting on commas so a paste lands as chips. */
  const commit = (text: string) => {
    const fresh = text
      .split(",")
      .map((term) => term.trim())
      .filter((term) => term && !terms.includes(term));
    if (fresh.length > 0) onChange([...terms, ...fresh]);
    setDraft("");
  };

  return (
    <div className="space-y-2 rounded-lg border bg-card p-2">
      {terms.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {terms.map((term, index) => (
            <li key={`${term}-${index}`}>
              <Badge variant="secondary" className="gap-1 pr-1">
                <span className="truncate">{term}</span>
                <button
                  type="button"
                  aria-label={`${removeLabel}: ${term}`}
                  onClick={() => onChange(terms.filter((_, i) => i !== index))}
                  className="cursor-pointer rounded-sm p-0.5 hover:bg-foreground/10"
                >
                  <X size={11} />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        // Blur commits too: a typed term left uncommitted would vanish silently.
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
            return;
          }
          if (e.key === "Backspace" && draft === "" && terms.length > 0) {
            onChange(terms.slice(0, -1));
          }
        }}
        className="border-0 shadow-none focus-visible:ring-0"
      />
    </div>
  );
}

/**
 * List of `{ name, value }` rules. A row shows the name; clicking it opens that
 * rule's markdown body, and only one is open at a time — a column of editors is
 * unreadable once there are more than two rules. Rows key by index (no stable
 * id, no reordering); `revision` keys the editors so an outside fill remounts
 * them.
 */
export function RuleList({
  rules,
  onChange,
  revision,
  idPrefix,
  add,
  namePlaceholder,
  bodyPlaceholder,
  mentions,
  citationWarning,
}: {
  rules: BrandRule[];
  onChange: (rules: BrandRule[]) => void;
  revision: number;
  idPrefix: string;
  add: string;
  namePlaceholder: string;
  bodyPlaceholder: string;
  /** Enables `@` in the body editor. Only formats cite site sections. */
  mentions?: MarkdownMentions;
  /** Message for a body citing something that doesn't exist, or null. */
  citationWarning?: (value: string) => string | null;
}) {
  const t = useT();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const replaceAt = (index: number, patch: Partial<BrandRule>) =>
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const remove = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
    // Indices shift on delete, so anything but the untouched prefix is stale.
    setOpenIndex((open) => (open === null || open < index ? open : null));
  };

  return (
    <div className="space-y-2">
      <ul className="divide-y overflow-hidden rounded-lg border">
        {rules.map((rule, index) => {
          const open = openIndex === index;
          return (
            <li key={index} className="group/item bg-card">
              <div className="flex items-center gap-1 pr-2">
                <button
                  type="button"
                  onClick={() => setOpenIndex(open ? null : index)}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                >
                  {open ? (
                    <ChevronDown size={14} className="shrink-0" />
                  ) : (
                    <ChevronRight
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  <span
                    className={cn(
                      "truncate",
                      !rule.name && "text-muted-foreground",
                    )}
                  >
                    {rule.name || t("sandbox.blogBrand.untitledRule")}
                  </span>
                </button>
                <RemoveButton
                  label={t("sandbox.blogBrand.removeItem")}
                  onClick={() => remove(index)}
                />
              </div>
              {open && (
                <RuleBody
                  rule={rule}
                  editorKey={`${idPrefix}-${index}-${revision}`}
                  namePlaceholder={namePlaceholder}
                  bodyPlaceholder={bodyPlaceholder}
                  mentions={mentions}
                  citationWarning={citationWarning}
                  onPatch={(patch) => replaceAt(index, patch)}
                />
              )}
            </li>
          );
        })}
      </ul>
      <AddButton
        label={add}
        onClick={() => {
          onChange([...rules, { name: "", value: "" }]);
          setOpenIndex(rules.length);
        }}
      />
    </div>
  );
}

/**
 * How long a citation may look broken while it is still being typed.
 *
 * `@Heading` passes through `@H`, `@He`, `@Hea` on the way in, and every one of
 * them is a name this site has no block for. Warning on each made the message
 * flash under the editor on every keystroke, which reads as the editor lagging.
 * Whether a brief cites something real is a question about settled text.
 */
const CITATION_SETTLE_MS = 600;

/** The open row's fields. Its own component so the warning can settle per row. */
function RuleBody({
  rule,
  editorKey,
  namePlaceholder,
  bodyPlaceholder,
  mentions,
  citationWarning,
  onPatch,
}: {
  rule: BrandRule;
  editorKey: string;
  namePlaceholder: string;
  bodyPlaceholder: string;
  mentions?: MarkdownMentions;
  citationWarning?: (value: string) => string | null;
  onPatch: (patch: Partial<BrandRule>) => void;
}) {
  const settled = useDebouncedValue(rule.value, CITATION_SETTLE_MS);
  const warning = citationWarning?.(settled);
  return (
    <div className="space-y-3 border-t bg-background px-3 py-3">
      <Input
        value={rule.name}
        placeholder={namePlaceholder}
        onChange={(e) => onPatch({ name: e.target.value })}
        className="h-9 font-medium"
      />
      <MarkdownEditor
        key={editorKey}
        defaultValue={rule.value}
        placeholder={bodyPlaceholder}
        attachments={false}
        mentions={mentions}
        onChange={(markdown) => onPatch({ value: markdown })}
      />
      {warning && <p className="text-xs text-warning">{warning}</p>}
    </div>
  );
}
