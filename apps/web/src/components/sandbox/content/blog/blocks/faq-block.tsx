import { useState } from "react";
import { ChevronDown, Link01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { useT } from "@/i18n/use-t.ts";
import { BlockDocument } from "../block-document";
import { uid } from "../block-items";
import { type RawBlock } from "./block-registry";
import { type FaqItem, parseFaqItems } from "./faq-items";
import { InlineRichCell } from "./inline-rich-cell";
import { useLinkSources } from "./link-pickers";
import { AddButton, normalizeAnchorId, RemoveButton, str } from "./primitives";

/** An answer is prose with the odd illustration — not a page of its own. */
const ANSWER_BLOCKS = [
  "Paragraph",
  "List",
  "BlockImage",
  "Divider",
  "Table",
] as const;

/**
 * Inline editor for the blog FAQ block (`blog/sections/blocks/FAQ.tsx`): a
 * list of questions, each an inline rich-text line, each answered by a nested
 * block document rather than a plain string — the section renders the answer
 * through `renderSection`, so anything the post editor can hold fits here too.
 *
 * Rows collapse so a long FAQ stays navigable; they all start open because a
 * collapsed answer reads as an empty one.
 */
export function FaqBlock({
  block,
  meta,
  onChange,
  decofile,
  sandboxRef,
}: {
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  /** The site's blocks — enables linking to another post from a question. */
  decofile?: Record<string, unknown>;
  /** Running sandbox coords — enables the VTEX product picker in answers. */
  sandboxRef?: PreviewProxyRef | null;
}) {
  const t = useT();
  const linkSources = useLinkSources({ decofile, sandboxRef });
  // Shared mount point for the question marks menus — see `InlineMarksToolbar`.
  const [menuHost, setMenuHost] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const items = parseFaqItems(block.items);

  // `InlineRichCell` is uncontrolled after mount — an index key would smear.
  const [ids, setIds] = useState<string[]>(() => items.map(() => uid()));
  if (ids.length !== items.length) {
    setIds(items.map((_, i) => ids[i] ?? uid()));
  }

  const commit = (nextItems: FaqItem[], nextIds: string[]) => {
    setIds(nextIds);
    onChange({ ...block, items: nextItems });
  };

  const set = (index: number, patch: Partial<FaqItem>) =>
    commit(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      ids,
    );

  const add = () =>
    commit([...items, { title: "", body: [] }], [...ids, uid()]);

  const remove = (index: number) =>
    commit(
      items.filter((_, i) => i !== index),
      ids.filter((_, i) => i !== index),
    );

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="relative space-y-2">
      <ul className="border-t border-border/60">
        {items.map((item, index) => {
          const id = ids[index] ?? String(index);
          const isOpen = !collapsed.has(id);
          return (
            <li
              key={id}
              className="group/item border-b border-border/60 py-2.5"
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={t("sandbox.faqBlock.toggleQuestion")}
                  onClick={() => toggle(id)}
                  className="mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ChevronDown
                    size={14}
                    className={cn(
                      "transition-transform",
                      !isOpen && "-rotate-90",
                    )}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <InlineRichCell
                    value={item.title}
                    onChange={(title) => set(index, { title })}
                    placeholder={t("sandbox.faqBlock.questionPlaceholder")}
                    className="text-[15px] font-semibold leading-snug"
                    menuHost={menuHost}
                    sources={linkSources}
                  />
                </div>
                <RemoveButton
                  label={t("sandbox.faqBlock.removeQuestion")}
                  onClick={() => remove(index)}
                />
              </div>
              {isOpen && (
                <div className="pl-7">
                  <BlockDocument
                    value={item.body}
                    onChange={(body) => set(index, { body })}
                    meta={meta}
                    decofile={decofile}
                    sandboxRef={sandboxRef}
                    allowBlocks={ANSWER_BLOCKS}
                    emptyMessage={t("sandbox.faqBlock.answerEmpty")}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <AddButton label={t("sandbox.faqBlock.addQuestion")} onClick={add} />

      <label className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
        <Link01 size={12} className="shrink-0" />
        <span className="shrink-0">{t("sandbox.faqBlock.anchorIdLabel")}</span>
        <input
          value={str(block.faqId)}
          onChange={(e) =>
            onChange({ ...block, faqId: normalizeAnchorId(e.target.value) })
          }
          placeholder={t("sandbox.faqBlock.anchorIdPlaceholder")}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </label>

      <div ref={setMenuHost} className="absolute z-20" />
    </div>
  );
}
