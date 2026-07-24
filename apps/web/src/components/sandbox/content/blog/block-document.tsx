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
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { RunBlockSandboxRef } from "@/components/sandbox/content/use-run-block";
import { discoverBlogBlockTypes } from "./blog-data";
import { InsertBlockDivider } from "./block-picker";
import { BlockRow } from "./blocks/block-row";
import { type RawBlock } from "./blocks/block-registry";

type BlockItem = { id: string; block: RawBlock };

export function asBlocks(value: unknown): RawBlock[] {
  return Array.isArray(value) ? (value as RawBlock[]) : [];
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
  sandboxRef,
  emptyMessage = "No content yet. Use ⊕ to add your first block.",
}: {
  value: RawBlock[];
  onChange: (next: RawBlock[]) => void;
  meta: LiveMeta;
  /** Running sandbox coords — enables the VTEX product picker in blocks. */
  sandboxRef?: RunBlockSandboxRef | null;
  emptyMessage?: string;
}) {
  const blockTypes = discoverBlogBlockTypes(meta);

  const [blockItems, setBlockItems] = useState<BlockItem[]>(() =>
    value.map((blk) => ({ id: uid(), block: blk })),
  );

  const ids = blockItems.map((x) => x.id);
  const blocks = blockItems.map((x) => x.block);

  const syncBlocks = (items: BlockItem[]) => {
    setBlockItems(items);
    onChange(items.map((x) => x.block));
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
      {blocks.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <InsertBlockDivider
            blockTypes={blockTypes}
            onInsert={(rt) => insertAt(0, rt)}
            alwaysShow={blocks.length === 0}
          />
          {blockItems.map(({ id, block: blk }, index) => (
            <div key={id}>
              <BlockRow
                id={id}
                block={blk}
                meta={meta}
                onChange={(v) => updateAt(index, v)}
                onDelete={() => removeAt(index)}
                onDuplicate={() => duplicateAt(index)}
                sandboxRef={sandboxRef}
              />
              <InsertBlockDivider
                blockTypes={blockTypes}
                onInsert={(rt) => insertAt(index + 1, rt)}
              />
            </div>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function uid(): string {
  return crypto.randomUUID();
}
