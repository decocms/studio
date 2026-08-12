import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SORTABLE_DROP_ANIMATION } from "@/lib/dnd-drop-animation.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
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
import {
  Copy01,
  DotsHorizontal,
  Edit01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { getIconComponent } from "../agent-icon";
import { resolveEffectiveMatcherRule } from "./matcher-rules";
import { resolveMatcherIconName } from "./matcher-icons";
import type { PageVariant } from "./page-variants";
import type { LiveMeta } from "./resolve-schema";
import {
  VARIANT_ROW_CLASS,
  VARIANT_SELECTED_ROW_CLASS,
} from "./section-variant-list";

export function VariantTabIcon({
  rule,
  matchers,
}: {
  rule: Record<string, unknown> | undefined;
  matchers: Array<{ resolveType: string; iconName: string }>;
}) {
  const rt = (rule?.__resolveType as string) ?? "";
  const fromSchema = matchers.find((m) => m.resolveType === rt)?.iconName;
  const iconName = fromSchema ?? resolveMatcherIconName(rt);
  const Icon = getIconComponent(iconName);
  if (!Icon) return null;
  return <Icon size={14} className="shrink-0" />;
}

interface VariantTabEntry {
  id: string;
  index: number;
  variant: PageVariant;
}

function pageVariantsDisplayKey(variants: PageVariant[]): string {
  return variants
    .map(
      (variant) =>
        `${variant.label}|${(variant.rule?.__resolveType as string) ?? ""}`,
    )
    .join("\n");
}

function createEntries(variants: PageVariant[]): VariantTabEntry[] {
  return variants.map((variant, index) => ({
    id: crypto.randomUUID(),
    index,
    variant,
  }));
}

/**
 * Re-derive entries for a changed variant list, reusing each tab's existing
 * id by matching on label rather than array position. A delete/duplicate
 * before a tab shifts every later tab's position, so matching by position
 * hands it a stale id — remounting its DnD-sortable identity and dropping
 * e.g. an open row menu on an unrelated tab.
 */
export function reuseVariantEntryIds(
  current: VariantTabEntry[],
  variants: PageVariant[],
): VariantTabEntry[] {
  // Duplicate tabs clone the label as-is, so match same-label entries FIFO.
  const byLabel = new Map<string, VariantTabEntry[]>();
  for (const entry of current) {
    const queue = byLabel.get(entry.variant.label);
    if (queue) queue.push(entry);
    else byLabel.set(entry.variant.label, [entry]);
  }
  return variants.map((variant, index) => {
    const prior = byLabel.get(variant.label)?.shift();
    return {
      id: prior?.id ?? crypto.randomUUID(),
      index,
      variant,
    };
  });
}

function remapEntryIndices(entries: VariantTabEntry[]): VariantTabEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    index,
  }));
}

function PageVariantRowContent({
  label,
  effectiveRule,
  matchers,
  canDelete,
  dragging,
  onRename,
  onDuplicate,
  onDelete,
}: {
  label: string;
  effectiveRule: Record<string, unknown> | undefined;
  matchers: Array<{ resolveType: string; iconName: string }>;
  canDelete: boolean;
  dragging?: boolean;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  return (
    <>
      <VariantTabIcon rule={effectiveRule} matchers={matchers} />
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
              aria-label={t("sectionsEditor.pageVariantTabs.actionsAriaLabel", {
                label,
              })}
              className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <DotsHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onRename?.();
              }}
            >
              <Edit01 size={14} />
              {t("sectionsEditor.pageVariantTabs.renameAction")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate?.();
              }}
            >
              <Copy01 size={14} />
              {t("sectionsEditor.pageVariantTabs.duplicateAction")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!canDelete}
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.();
              }}
            >
              <Trash01 size={14} />
              {t("sectionsEditor.pageVariantTabs.deleteAction")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function SortablePageVariantRow({
  entry,
  isActive,
  canDelete,
  decofile,
  meta,
  matchers,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
}: {
  entry: VariantTabEntry;
  isActive: boolean;
  canDelete: boolean;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  matchers: Array<{ resolveType: string; iconName: string }>;
  onSelect: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({
      id: entry.id,
      animateLayoutChanges: () => false,
    });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, x: 0 } : null,
    ),
    opacity: isDragging ? 0 : undefined,
  };

  const effectiveRule = resolveEffectiveMatcherRule(
    entry.variant.rule,
    decofile,
    meta ?? undefined,
  );

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
        isDragging
          ? "cursor-grabbing"
          : "cursor-pointer active:cursor-grabbing",
        isActive ? VARIANT_SELECTED_ROW_CLASS : VARIANT_ROW_CLASS,
      )}
    >
      <PageVariantRowContent
        label={entry.variant.label}
        effectiveRule={effectiveRule}
        matchers={matchers}
        canDelete={canDelete}
        onRename={onRename}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
    </div>
  );
}

function PageVariantRowPreview({
  variant,
  decofile,
  meta,
  matchers,
}: {
  variant: PageVariant;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  matchers: Array<{ resolveType: string; iconName: string }>;
}) {
  const effectiveRule = resolveEffectiveMatcherRule(
    variant.rule,
    decofile,
    meta ?? undefined,
  );

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-2.5 shadow-lg ring-1 ring-border/60 cursor-grabbing",
        VARIANT_SELECTED_ROW_CLASS,
      )}
    >
      <PageVariantRowContent
        label={variant.label}
        effectiveRule={effectiveRule}
        matchers={matchers}
        canDelete={false}
        dragging
      />
    </div>
  );
}

export function PageVariantTabs({
  listKey,
  variants,
  activeIndex,
  decofile,
  meta,
  matchers,
  onSelect,
  onReorder,
  onRename,
  onDuplicate,
  onDelete,
  onAdd,
}: {
  listKey: string;
  variants: PageVariant[];
  activeIndex: number;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  matchers: Array<{ resolveType: string; iconName: string }>;
  onSelect: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRename: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<VariantTabEntry[]>(() =>
    createEntries(variants),
  );
  const [activeEntry, setActiveEntry] = useState<VariantTabEntry | null>(null);
  const [prevListKey, setPrevListKey] = useState(listKey);
  const [prevVariantCount, setPrevVariantCount] = useState(variants.length);
  const [prevDisplayKey, setPrevDisplayKey] = useState(() =>
    pageVariantsDisplayKey(variants),
  );
  const suppressClickRef = useRef(false);

  const displayKey = pageVariantsDisplayKey(variants);

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
    // changes the display key).
    setPrevVariantCount(variants.length);
    setPrevDisplayKey(displayKey);
    setEntries((current) => reuseVariantEntryIds(current, variants));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const entryIds = entries.map((entry) => entry.id);
  const canDelete = variants.length > 1;

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
          {t("sectionsEditor.pageVariantTabs.variantsLabel")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t(
                "sectionsEditor.pageVariantTabs.addVariantAriaLabel",
              )}
              className="size-6"
              onClick={onAdd}
            >
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("sectionsEditor.pageVariantTabs.addVariantTooltip")}
          </TooltipContent>
        </Tooltip>
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
              <SortablePageVariantRow
                key={entry.id}
                entry={entry}
                isActive={entry.index === activeIndex}
                canDelete={canDelete}
                decofile={decofile}
                meta={meta}
                matchers={matchers}
                onSelect={() => handleSelect(entry.index)}
                onRename={() => onRename(entry.index)}
                onDuplicate={() => onDuplicate(entry.index)}
                onDelete={() => onDelete(entry.index)}
              />
            ))}
          </div>
        </SortableContext>

        {/* Portal to body so the overlay's `position: fixed` resolves against
            the viewport, not the workspace PanelCard's `transform:
            translateZ(0)` containing block (which would drop the dragged tab
            below the cursor). */}
        {createPortal(
          <DragOverlay dropAnimation={SORTABLE_DROP_ANIMATION}>
            {activeEntry ? (
              <PageVariantRowPreview
                variant={activeEntry.variant}
                decofile={decofile}
                meta={meta}
                matchers={matchers}
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  );
}
