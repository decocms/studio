import { useRef, useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
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
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsHorizontal, Edit01, Plus, Trash01 } from "@untitledui/icons";
import { getIconComponent } from "../agent-icon";
import { resolveEffectiveMatcherRule } from "./matcher-rules";
import { resolveMatcherIconName } from "./matcher-icons";
import type { PageVariant } from "./page-variants";
import type { LiveMeta } from "./resolve-schema";

const VARIANT_GREEN_TEXT = "oklch(0.65 0.15 160)";
const VARIANT_TAB_ACTIVE_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.22)]";

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

function remapEntryIndices(entries: VariantTabEntry[]): VariantTabEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    index,
  }));
}

function SortablePageVariantTab({
  entry,
  sortableId,
  isActive,
  canDelete,
  decofile,
  meta,
  matchers,
  onSelect,
  onRename,
  onDelete,
}: {
  entry: VariantTabEntry;
  sortableId: string;
  isActive: boolean;
  canDelete: boolean;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  matchers: Array<{ resolveType: string; iconName: string }>;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({
      id: sortableId,
      animateLayoutChanges: () => false,
    });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, y: 0 } : null,
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
      className={cn(
        "group shrink-0 inline-flex items-center rounded-md transition-colors touch-none",
        isActive
          ? VARIANT_TAB_ACTIVE_CLASS
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={onSelect}
        className="inline-flex items-center gap-1.5 h-8 pl-3 pr-1.5 text-sm font-medium cursor-[inherit]"
      >
        <VariantTabIcon rule={effectiveRule} matchers={matchers} />
        <span className="truncate">{entry.variant.label}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${entry.variant.label}`}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex h-8 w-6 items-center justify-center pr-1 cursor-pointer transition-opacity",
              "opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100",
              isActive && "opacity-100",
            )}
          >
            <DotsHorizontal size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-36">
          <DropdownMenuItem onClick={onRename}>
            <Edit01 size={14} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!canDelete}
            onClick={onDelete}
          >
            <Trash01 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PageVariantTabPreview({
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
        "inline-flex items-center gap-1.5 h-8 pl-3 pr-3 text-sm font-medium rounded-md shadow-lg ring-1 ring-border/60 cursor-grabbing",
        VARIANT_TAB_ACTIVE_CLASS,
      )}
    >
      <VariantTabIcon rule={effectiveRule} matchers={matchers} />
      <span className="truncate">{variant.label}</span>
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
  onDelete: (index: number) => void;
  onAdd: () => void;
}) {
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
  } else if (prevVariantCount !== variants.length) {
    setPrevVariantCount(variants.length);
    setPrevDisplayKey(displayKey);
    setEntries(createEntries(variants));
  } else if (prevDisplayKey !== displayKey) {
    setPrevDisplayKey(displayKey);
    setEntries((current) =>
      variants.map((variant, index) => {
        const prior = current[index];
        return {
          id: prior?.id ?? crypto.randomUUID(),
          index,
          variant,
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
    <div className="flex items-center border-b shrink-0">
      <div
        className={cn(
          "flex flex-1 min-w-0 items-center gap-1.5 pl-3 pr-2 py-2 overflow-x-auto",
          activeEntry && "cursor-grabbing",
        )}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={entryIds}
            strategy={horizontalListSortingStrategy}
          >
            {entries.map((entry) => (
              <SortablePageVariantTab
                key={entry.id}
                sortableId={entry.id}
                entry={entry}
                isActive={entry.index === activeIndex}
                canDelete={canDelete}
                decofile={decofile}
                meta={meta}
                matchers={matchers}
                onSelect={() => handleSelect(entry.index)}
                onRename={() => onRename(entry.index)}
                onDelete={() => onDelete(entry.index)}
              />
            ))}
          </SortableContext>

          <DragOverlay dropAnimation={null}>
            {activeEntry ? (
              <PageVariantTabPreview
                variant={activeEntry.variant}
                decofile={decofile}
                meta={meta}
                matchers={matchers}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      <div className="shrink-0 pr-3 pl-1 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Add variant"
              className="size-8 shrink-0 cursor-pointer"
              style={{ color: VARIANT_GREEN_TEXT }}
              onClick={onAdd}
            >
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add variant</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
