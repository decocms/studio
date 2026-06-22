import { useState } from "react";
import { Copy01, DotsGrid, Trash01 } from "@untitledui/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@deco/ui/lib/utils.js";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { BlockEditor, type RawBlock } from "./block-registry";

/**
 * Pixel height below which the row can't fit three 24px buttons stacked
 * vertically with 4px gaps (3*24 + 2*4 = 80, plus the 6px top inset).
 * Short blocks (divider, empty paragraph, single-line heading) fall under
 * this and switch to the inline action layout.
 */
const SHORT_ROW_THRESHOLD_PX = 80;

/**
 * One block in the post document. Borderless (Notion-style) — the left
 * gutter reveals a drag handle on hover; for tall blocks the duplicate
 * and delete buttons stack underneath, but for short blocks they move to
 * the right edge inline so they don't overflow below the row. Dragging
 * is bound to the handle only so it never fights with text editing.
 */
export function BlockRow({
  id,
  block,
  meta,
  onChange,
  onDelete,
  onDuplicate,
}: {
  id: string;
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const [isShort, setIsShort] = useState(false);

  return (
    <div
      // React 19 ref callback: wires dnd-kit's setNodeRef and starts a
      // ResizeObserver in the same hook. Returning the cleanup tells React
      // to disconnect when the element unmounts.
      ref={(el) => {
        setNodeRef(el);
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
          if (!entry) return;
          setIsShort(entry.contentRect.height < SHORT_ROW_THRESHOLD_PX);
        });
        ro.observe(el);
        return () => ro.disconnect();
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group/row relative rounded-md py-1.5 pl-12 transition-colors hover:bg-muted/40",
        // Short rows host duplicate+delete inline on the right, so reserve
        // gutter there too. Tall rows only need a small right margin.
        isShort ? "pr-20" : "pr-2",
        isDragging && "opacity-50",
      )}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        className="absolute left-1 top-1.5 flex h-6 w-6 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground active:cursor-grabbing group-hover/row:opacity-100"
        {...attributes}
        {...listeners}
      >
        <DotsGrid size={14} />
      </button>
      <div
        className={cn(
          "absolute flex gap-1 opacity-0 transition-opacity group-hover/row:opacity-100",
          isShort
            ? "right-2 top-1.5 flex-row"
            : "left-1 top-9 flex-col items-center",
        )}
      >
        <button
          type="button"
          aria-label="Duplicate block"
          onClick={onDuplicate}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <Copy01 size={14} />
        </button>
        <button
          type="button"
          aria-label="Delete block"
          onClick={onDelete}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive cursor-pointer"
        >
          <Trash01 size={14} />
        </button>
      </div>
      <BlockEditor block={block} meta={meta} onChange={onChange} />
    </div>
  );
}
