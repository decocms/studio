import { Copy01, DotsGrid, Trash01 } from "@untitledui/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { SandboxConfig } from "@/components/sections-editor/fields/field-props";
import type { ReferencedBlockSaveFn } from "@/components/sections-editor/save-referenced-block";
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
  decofile,
  sandboxRef,
  previewBaseUrl,
  onSaveReferencedBlock,
  dense = false,
}: {
  id: string;
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  decofile?: Record<string, unknown>;
  sandboxRef?: SandboxConfig | null;
  previewBaseUrl?: string | null;
  onSaveReferencedBlock?: ReferencedBlockSaveFn;
  /** A row of a document nested in another block: a narrow gutter, no hover fill. */
  dense?: boolean;
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
        "relative rounded-md [&:hover>[data-row-control]]:opacity-100",
        dense
          ? "py-0.5 pl-6 pr-1"
          : "py-1.5 pl-12 pr-2 transition-colors hover:bg-accent",
        isDragging && "opacity-50",
      )}
    >
      <button
        type="button"
        aria-label={t("sandbox.blockRow.dragToReorder")}
        data-row-control
        className={cn(
          "absolute flex cursor-grab items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground active:cursor-grabbing",
          dense ? "left-0 top-0.5 h-5 w-5" : "left-1 top-1.5 h-6 w-6",
        )}
        {...attributes}
        {...listeners}
      >
        <DotsGrid size={14} />
      </button>
      <div
        data-row-control
        className="absolute right-1 top-1 z-10 flex flex-row gap-0.5 rounded-md bg-background/80 opacity-0 backdrop-blur-sm transition-opacity"
      >
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={t("sandbox.blockRow.duplicateBlock")}
          onClick={onDuplicate}
        >
          <Copy01 className="size-3.5" />
        </Button>
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          type="button"
          aria-label={t("sandbox.blockRow.deleteBlock")}
          onClick={onDelete}
        >
          <Trash01 className="size-3.5" />
        </Button>
      </div>
      <BlockEditor
        block={block}
        meta={meta}
        onChange={onChange}
        decofile={decofile}
        sandboxRef={sandboxRef}
        previewBaseUrl={previewBaseUrl}
        onSaveReferencedBlock={onSaveReferencedBlock}
      />
    </div>
  );
}
