import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SORTABLE_DROP_ANIMATION } from "@/lib/dnd-drop-animation.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  Copy01,
  DotsGrid,
  DotsHorizontal,
  Edit03,
  LayoutAlt01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useT } from "@/i18n/use-t.ts";

const VARIANT_ICON_COLOR = "oklch(0.65 0.15 160)";
// Exported: page-variant-tabs.tsx and section-list.tsx share this exact
// variant-row styling and import it here rather than re-declaring it.
export const VARIANT_ROW_CLASS =
  "text-[oklch(0.45_0.15_160)] hover:bg-[oklch(0.65_0.15_160/0.12)] dark:text-[oklch(0.78_0.15_160)] dark:hover:bg-[oklch(0.65_0.15_160/0.15)]";
export const VARIANT_SELECTED_ROW_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.2)]";
export const VARIANT_MENU_ITEM_CLASS =
  "text-[oklch(0.45_0.15_160)] focus:bg-[oklch(0.65_0.15_160/0.12)] focus:text-[oklch(0.45_0.15_160)] dark:text-[oklch(0.78_0.15_160)] dark:focus:bg-[oklch(0.65_0.15_160/0.15)] dark:focus:text-[oklch(0.78_0.15_160)]";

export interface SectionVariantEntry {
  index: number;
  label: string;
}

interface SortableVariantEntry {
  id: string;
  index: number;
  label: string;
}

function variantsDisplayKey(variants: SectionVariantEntry[]): string {
  return variants.map((variant) => variant.label).join("\n");
}

function createEntries(
  variants: SectionVariantEntry[],
): SortableVariantEntry[] {
  return variants.map((variant) => ({
    id: crypto.randomUUID(),
    index: variant.index,
    label: variant.label,
  }));
}

function remapEntryIndices(
  entries: SortableVariantEntry[],
): SortableVariantEntry[] {
  return entries.map((entry, index) => ({ ...entry, index }));
}

function VariantRowContent({
  label,
  canDelete,
  dragging,
  onRename,
  onDuplicate,
  onDelete,
}: {
  label: string;
  canDelete: boolean;
  dragging?: boolean;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();

  return (
    <>
      <DotsGrid
        className={cn(
          "h-4 w-4 shrink-0 text-muted-foreground/40 transition-opacity",
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      />
      <LayoutAlt01
        className="h-4 w-4 shrink-0"
        style={{ color: VARIANT_ICON_COLOR }}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {label}
      </span>

      {!dragging && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t(
                "sectionsEditor.sectionVariantList.openActionsFor",
                { label },
              )}
              className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <DotsHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onRename && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
              >
                <Edit03 size={14} />
                {t("sectionsEditor.sectionVariantList.rename")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate?.();
              }}
            >
              <Copy01 size={14} />
              {t("sectionsEditor.sectionVariantList.duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!canDelete}
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.();
              }}
            >
              <Trash01 size={14} />
              {t("sectionsEditor.sectionVariantList.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function SortableVariantRow({
  entry,
  selected,
  canDelete,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
}: {
  entry: SortableVariantEntry;
  selected: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onRename?: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({ id: entry.id, animateLayoutChanges: () => false });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, x: 0 } : null,
    ),
    opacity: isDragging ? 0 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex select-none items-center gap-2 rounded-md px-2 py-2.5 transition-colors touch-none",
        isDragging ? "cursor-grabbing" : "cursor-grab",
        selected ? VARIANT_SELECTED_ROW_CLASS : VARIANT_ROW_CLASS,
      )}
    >
      <VariantRowContent
        label={entry.label}
        canDelete={canDelete}
        onRename={onRename}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
    </div>
  );
}

export function SectionVariantList({
  listKey,
  variants,
  selectedIndex,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
  onRemoveAll,
  onReorder,
  onAdd,
}: {
  listKey: string;
  variants: SectionVariantEntry[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onRename?: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onRemoveAll: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const canDelete = variants.length > 1;

  const [entries, setEntries] = useState<SortableVariantEntry[]>(() =>
    createEntries(variants),
  );
  const [activeEntry, setActiveEntry] = useState<SortableVariantEntry | null>(
    null,
  );
  const [prevListKey, setPrevListKey] = useState(listKey);
  const [prevVariantCount, setPrevVariantCount] = useState(variants.length);
  const [prevDisplayKey, setPrevDisplayKey] = useState(() =>
    variantsDisplayKey(variants),
  );
  const suppressClickRef = useRef(false);

  const displayKey = variantsDisplayKey(variants);

  if (prevListKey !== listKey) {
    setPrevListKey(listKey);
    setPrevVariantCount(variants.length);
    setPrevDisplayKey(displayKey);
    setEntries(createEntries(variants));
  } else if (
    prevVariantCount !== variants.length ||
    prevDisplayKey !== displayKey
  ) {
    // Duplicate/delete/reorder all land here (a count change always also
    // changes the display key). Reuse each position's existing id rather than
    // minting fresh ones for every row — otherwise duplicating or deleting one
    // variant remounts every OTHER row's DnD-sortable identity too, dropping
    // e.g. an open row menu on an unrelated row.
    setPrevVariantCount(variants.length);
    setPrevDisplayKey(displayKey);
    setEntries((current) =>
      variants.map((variant, index) => {
        const prior = current[index];
        return {
          id: prior?.id ?? crypto.randomUUID(),
          index: variant.index,
          label: variant.label,
        };
      }),
    );
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const entryIds = entries.map((entry) => entry.id);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveEntry(entries.find((entry) => entry.id === id) ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveEntry(null);

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = entryIds.indexOf(String(active.id));
    const newIndex = entryIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    setEntries((current) =>
      remapEntryIndices(arrayMove([...current], oldIndex, newIndex)),
    );
    suppressClickRef.current = true;
    requestAnimationFrame(() => {
      suppressClickRef.current = false;
    });
    onReorder(oldIndex, newIndex);
  };

  const handleDragCancel = () => {
    setActiveEntry(null);
  };

  const handleSelect = (index: number) => {
    if (suppressClickRef.current) return;
    onSelect(index);
  };

  return (
    <div className="space-y-1 border-b p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {t("sectionsEditor.sectionVariantList.title")}
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t(
                  "sectionsEditor.sectionVariantList.addVariantAriaLabel",
                )}
                className="size-6"
                onClick={onAdd}
              >
                <Plus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("sectionsEditor.sectionVariantList.addVariant")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t(
                  "sectionsEditor.sectionVariantList.removeAllVariantsAriaLabel",
                )}
                className="size-6 text-muted-foreground hover:text-destructive"
                onClick={onRemoveAll}
              >
                <Trash01 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("sectionsEditor.sectionVariantList.removeAllVariants")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={entryIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-0.5">
            {entries.map((entry) => (
              <SortableVariantRow
                key={entry.id}
                entry={entry}
                selected={entry.index === selectedIndex}
                canDelete={canDelete}
                onSelect={() => handleSelect(entry.index)}
                onRename={onRename ? () => onRename(entry.index) : undefined}
                onDuplicate={() => onDuplicate(entry.index)}
                onDelete={() => onDelete(entry.index)}
              />
            ))}
          </div>
        </SortableContext>

        {/* Portal to body so the overlay's `position: fixed` resolves against
            the viewport, not the workspace PanelCard's `transform:
            translateZ(0)` containing block (which would drop the dragged row
            below the cursor). */}
        {createPortal(
          <DragOverlay dropAnimation={SORTABLE_DROP_ANIMATION}>
            {activeEntry ? (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-2.5 shadow-lg ring-1 ring-border/60 cursor-grabbing",
                  VARIANT_SELECTED_ROW_CLASS,
                )}
              >
                <VariantRowContent
                  label={activeEntry.label}
                  canDelete={canDelete}
                  dragging
                />
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  );
}
