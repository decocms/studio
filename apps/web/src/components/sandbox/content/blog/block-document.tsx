import { useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus } from "@untitledui/icons";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { useT } from "@/i18n/use-t.ts";
import { type BlogBlockType, discoverBlogBlockTypes } from "./blog-data";
import { BlockPicker } from "./block-picker";
import { BlockRow } from "./blocks/block-row";
import { type RawBlock } from "./blocks/block-registry";
import {
  reseedBlockItems,
  seedBlockItems,
  uid,
  type BlockItem,
} from "./block-items";

export function asBlocks(value: unknown): RawBlock[] {
  return Array.isArray(value) ? (value as RawBlock[]) : [];
}

/**
 * A slim insert affordance in the gap between two blocks: invisible until the
 * gap is hovered, then a hairline with a centered ⊕ fades in. Inserts at this
 * position, so the ⊕ lives between blocks, not attached to one.
 */
function InsertBetween({
  blockTypes,
  onInsert,
}: {
  blockTypes: BlogBlockType[];
  onInsert: (resolveType: string) => void;
}) {
  const t = useT();
  return (
    <BlockPicker blockTypes={blockTypes} onInsert={onInsert} align="center">
      <button
        type="button"
        aria-label={t("sandbox.blockPicker.insertBlockButton")}
        className="group/ins relative flex h-2.5 w-full items-center justify-center opacity-0 transition-opacity hover:opacity-100 cursor-pointer"
      >
        <span className="absolute inset-x-10 top-1/2 h-px -translate-y-1/2 bg-primary/30" />
        <span className="relative z-10 flex h-5 w-5 items-center justify-center rounded-lg border bg-background text-muted-foreground">
          <Plus size={12} />
        </span>
      </button>
    </BlockPicker>
  );
}

/**
 * Notion-style block document: a vertical list of inline-editable blocks
 * with ⊕ insert affordances between rows and drag-to-reorder. The caller
 * owns the persisted `value`; this component owns the dnd-kit identity
 * (`uid()`-keyed `BlockItem`s) so reorders don't lose React keys.
 */
export function BlockDocument({
  value,
  onChange,
  meta,
  decofile,
  sandboxRef,
  emptyMessage = "No content yet. Add your first block below.",
}: {
  value: RawBlock[];
  onChange: (next: RawBlock[]) => void;
  meta: LiveMeta;
  /** The site's blocks — enables linking to another post from rich text. */
  decofile?: Record<string, unknown>;
  /** Running sandbox coords — enables the VTEX product picker in blocks. */
  sandboxRef?: PreviewProxyRef | null;
  emptyMessage?: string;
}) {
  const t = useT();
  const blockTypes = discoverBlogBlockTypes(meta);

  const [blockItems, setBlockItems] = useState<BlockItem[]>(() =>
    seedBlockItems(value),
  );
  // Re-seed when `value` changes for a reason other than our own onChange echo.
  const [lastEmitted, setLastEmitted] = useState(value);
  if (value !== lastEmitted) {
    setLastEmitted(value);
    setBlockItems(reseedBlockItems(blockItems, value));
  }

  const ids = blockItems.map((x) => x.id);
  const blocks = blockItems.map((x) => x.block);

  const syncBlocks = (items: BlockItem[]) => {
    setBlockItems(items);
    const next = items.map((x) => x.block);
    setLastEmitted(next);
    onChange(next);
  };

  const insertAt = (index: number, resolveType: string) => {
    const next = [...blockItems];
    next.splice(index, 0, { id: uid(), block: { __resolveType: resolveType } });
    syncBlocks(next);
  };

  const updateAt = (index: number, value: RawBlock) => {
    syncBlocks(
      blockItems.map((item, i) =>
        i === index ? { ...item, block: value } : item,
      ),
    );
  };

  const removeAt = (index: number) => {
    syncBlocks(blockItems.filter((_, i) => i !== index));
  };

  // structuredClone deep-copies the block payload so the duplicate doesn't
  // share nested references (e.g. arrays inside ProductShelf) with the
  // original — editing one would otherwise mutate the other.
  const duplicateAt = (index: number) => {
    const source = blockItems[index];
    if (!source) return;
    const next = [...blockItems];
    next.splice(index + 1, 0, {
      id: uid(),
      block: structuredClone(source.block),
    });
    syncBlocks(next);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = blockItems.findIndex((x) => x.id === String(active.id));
    const newIndex = blockItems.findIndex((x) => x.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    syncBlocks(arrayMove(blockItems, oldIndex, newIndex));
  };

  return (
    <div className="mt-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {blockItems.map(({ id, block: blk }, index) => (
            <div key={id}>
              <InsertBetween
                blockTypes={blockTypes}
                onInsert={(rt) => insertAt(index, rt)}
              />
              <BlockRow
                id={id}
                block={blk}
                meta={meta}
                onChange={(v) => updateAt(index, v)}
                onDelete={() => removeAt(index)}
                onDuplicate={() => duplicateAt(index)}
                decofile={decofile}
                sandboxRef={sandboxRef}
              />
            </div>
          ))}
        </SortableContext>
      </DndContext>

      {blocks.length === 0 && (
        <p className="px-3 pb-1 pt-2 text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      )}

      <BlockPicker
        blockTypes={blockTypes}
        onInsert={(rt) => insertAt(blockItems.length, rt)}
      >
        <button
          type="button"
          className="mt-1 flex w-full items-center gap-2 rounded-md py-2 pl-14 pr-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground cursor-pointer"
        >
          <Plus size={16} />
          {t("sandbox.blockDocument.addBlock")}
        </button>
      </BlockPicker>
    </div>
  );
}
