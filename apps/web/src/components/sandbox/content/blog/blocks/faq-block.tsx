import { useState } from "react";
import { ChevronDown, Link01, MessageQuestionSquare } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { SandboxConfig } from "@/components/sections-editor/fields/field-props";
import type { ReferencedBlockSaveFn } from "@/components/sections-editor/save-referenced-block";
import { useHideDefaultBlogBlocks } from "@/hooks/use-hide-default-blog-blocks";
import { useT } from "@/i18n/use-t.ts";
import { BlockDocument } from "../block-document";
import { uid } from "../block-items";
import { customBlogSectionPaths, sectionResolveTypes } from "../blog-data";
import { type RawBlock } from "./block-registry";
import { type FaqItem, parseFaqItems } from "./faq-items";
import { InlineRichCell } from "./inline-rich-cell";
import { useLinkSources } from "./link-pickers";
import { AddButton, normalizeAnchorId, RemoveButton, str } from "./primitives";

/** An answer is prose with the odd illustration, not a page of its own. */
const ANSWER_BLOCKS = [
  "Paragraph",
  "List",
  "BlockImage",
  "Divider",
  "Table",
] as const;

/**
 * Inline editor for the blog FAQ block, drawn as the accordion the site
 * renders: one card, a row per question, the answer under it. A question is a
 * line of inline rich text. An answer is a nested block document, because the
 * site renders it section by section.
 *
 * Rows collapse so a long FAQ stays navigable. They start open, because a
 * collapsed answer reads as an empty one.
 */
export function FaqBlock({
  block,
  meta,
  onChange,
  decofile,
  sandboxRef,
  previewBaseUrl,
  onSaveReferencedBlock,
}: {
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  /** The site's blocks, which let a question or an answer link to another post. */
  decofile?: Record<string, unknown>;
  /** Running sandbox coords, for the pickers and uploads of the answer's blocks. */
  sandboxRef?: SandboxConfig | null;
  previewBaseUrl?: string | null;
  onSaveReferencedBlock?: ReferencedBlockSaveFn;
}) {
  const t = useT();
  const linkSources = useLinkSources({ decofile, sandboxRef });
  const hideDefaults = useHideDefaultBlogBlocks();
  const paragraph = sectionResolveTypes(meta, {
    hideDefaults,
    customPaths: decofile ? customBlogSectionPaths(decofile) : [],
  }).Paragraph;
  const [menuHost, setMenuHost] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const items = parseFaqItems(block.items);

  // A question's editor is uncontrolled after mount, so a row needs a key that survives a removal above it.
  const [ids, setIds] = useState<string[]>(() => items.map(() => uid()));
  if (ids.length !== items.length) {
    setIds(items.map((_, index) => ids[index] ?? uid()));
  }

  const commit = (nextItems: FaqItem[], nextIds: string[]) => {
    setIds(nextIds);
    onChange({ ...block, items: nextItems });
  };

  const patch = (index: number, change: Partial<FaqItem>) =>
    commit(
      items.map((item, i) => (i === index ? { ...item, ...change } : item)),
      ids,
    );

  // A new answer opens with a paragraph, so it can be typed straight away.
  const add = () =>
    commit(
      [
        ...items,
        { title: "", body: paragraph ? [{ __resolveType: paragraph }] : [] },
      ],
      [...ids, uid()],
    );

  const remove = (index: number) =>
    commit(
      items.filter((_, i) => i !== index),
      ids.filter((_, i) => i !== index),
    );

  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="relative">
      <div className="rounded-lg border">
        <div className="flex items-center gap-1.5 rounded-t-lg border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <MessageQuestionSquare size={13} className="shrink-0" />
          {t("sandbox.faqBlock.title")}
        </div>

        <ul className="divide-y">
          {items.map((item, index) => {
            const id = ids[index] ?? String(index);
            const open = !collapsed.has(id);
            return (
              <li key={id}>
                <div
                  className={cn(
                    "group/item flex items-start gap-2 px-3 pt-3",
                    open ? "pb-0.5" : "pb-2.5",
                  )}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={t("sandbox.faqBlock.toggleQuestion")}
                    onClick={() => toggle(id)}
                    className="mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <ChevronDown
                      size={14}
                      className={cn(
                        "transition-transform",
                        !open && "-rotate-90",
                      )}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <InlineRichCell
                      value={item.title}
                      onChange={(title) => patch(index, { title })}
                      placeholder={t("sandbox.faqBlock.questionPlaceholder")}
                      className="text-[15px] font-medium leading-snug"
                      menuHost={menuHost}
                      sources={linkSources}
                    />
                  </div>
                  <RemoveButton
                    label={t("sandbox.faqBlock.removeQuestion")}
                    onClick={() => remove(index)}
                  />
                </div>
                {open && (
                  <div className="pb-2.5 pl-4 pr-3">
                    <BlockDocument
                      value={item.body}
                      onChange={(body) => patch(index, { body })}
                      meta={meta}
                      decofile={decofile}
                      sandboxRef={sandboxRef}
                      previewBaseUrl={previewBaseUrl}
                      onSaveReferencedBlock={onSaveReferencedBlock}
                      allowBlocks={ANSWER_BLOCKS}
                      emptyMessage=""
                      addLabel={t("sandbox.faqBlock.addAnswerBlock")}
                      dense
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2",
            items.length > 0 && "border-t",
          )}
        >
          <AddButton label={t("sandbox.faqBlock.addQuestion")} onClick={add} />
          <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Link01 size={12} className="shrink-0" />
            <span className="shrink-0">
              {t("sandbox.faqBlock.anchorIdLabel")}
            </span>
            <input
              value={str(block.faqId)}
              onChange={(e) =>
                onChange({ ...block, faqId: normalizeAnchorId(e.target.value) })
              }
              placeholder={t("sandbox.faqBlock.anchorIdPlaceholder")}
              className="w-24 min-w-0 border-0 bg-transparent p-0 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-0"
            />
          </label>
        </div>
      </div>

      <div ref={setMenuHost} className="absolute z-20" />
    </div>
  );
}
