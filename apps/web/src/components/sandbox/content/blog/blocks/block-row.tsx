import { Copy01, DotsGrid, Trash01 } from "@untitledui/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { useT } from "@/i18n/use-t.ts";
import { BlockEditor, type RawBlock } from "./block-registry";

/**
 * One block in the post document. Borderless (Notion-style) — the left
 * gutter reveals a drag handle on hover; the duplicate and delete buttons
 * appear as a hover overlay at the top-right. The block's horizontal
 * padding is constant (it never depends on the row's height) so typing in a
 * paragraph never reflows the text — measuring height to switch the layout
 * made blocks near the threshold jitter as the wrap width changed per
 * keystroke. Dragging is bound to the handle only so it never fights with
 * text editing.
 */
export function BlockRow({
  id,
  block,
  meta,
  onChange,
  onDelete,
  onDuplicate,
  sandboxRef,
}: {
  id: string;
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  sandboxRef?: PreviewProxyRef | null;
}) {
  const t = useT();
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
      <button
        type="button"
        aria-label={t("sandbox.blockRow.dragToReorder")}
        className="absolute left-1 top-1.5 flex h-6 w-6 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground active:cursor-grabbing group-hover/row:opacity-100"
        {...attributes}
        {...listeners}
      >
        <DotsGrid size={14} />
      </button>
      <div className="absolute right-1 top-1 z-10 flex flex-row gap-0.5 rounded-md bg-background/80 opacity-0 backdrop-blur-sm transition-opacity group-hover/row:opacity-100">
        <button
          type="button"
          aria-label={t("sandbox.blockRow.duplicateBlock")}
          onClick={onDuplicate}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <Copy01 size={14} />
        </button>
        <button
          type="button"
          aria-label={t("sandbox.blockRow.deleteBlock")}
          onClick={onDelete}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive cursor-pointer"
        >
          <Trash01 size={14} />
        </button>
      </div>
      <BlockEditor
        block={block}
        meta={meta}
        onChange={onChange}
        sandboxRef={sandboxRef}
      />
    </div>
  );
}
