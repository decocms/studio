import { DotsGrid, Trash01 } from "@untitledui/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@deco/ui/lib/utils.js";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { BlockEditor, type RawBlock } from "./block-registry";

/**
 * One block in the post document. Borderless (Notion-style) — the gutter on
 * the left reveals a drag handle and delete on hover; the body renders the
 * block's native inline editor. Dragging is bound to the handle only so it
 * never fights with selecting/editing the block text.
 */
export function BlockRow({
  id,
  block,
  meta,
  onChange,
  onDelete,
}: {
  id: string;
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group/row relative rounded-md py-1.5 pl-12 pr-2 transition-colors hover:bg-muted/40",
        isDragging && "opacity-50",
      )}
    >
      <div className="absolute left-1 top-1.5 flex flex-col items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
        <button
          type="button"
          aria-label="Drag to reorder"
          className="flex h-6 w-6 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <DotsGrid size={14} />
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
