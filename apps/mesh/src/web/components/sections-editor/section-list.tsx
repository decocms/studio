import { useRef, useState } from "react";
import { cn } from "@deco/ui/lib/utils.js";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Copy01,
  DotsGrid,
  DotsHorizontal,
  Eye,
  EyeOff,
  LayoutAlt01,
  Plus,
  Trash01,
  Zap,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
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
import { canMakeSectionReusable } from "./page-sections";
import {
  GLOBAL_SECTION_ICON_COLOR,
  sectionsDisplayKey,
  type RawSection,
} from "./section-types";
import { parseSections, type ParsedSection } from "./parse-sections";

export { parseSections, type ParsedSection, type RawSection };

const GLOBAL_SECTION_ROW_CLASS =
  "text-[oklch(0.45_0.15_289)] hover:bg-[oklch(0.7278_0.151_289/0.12)] dark:text-[oklch(0.78_0.15_289)] dark:hover:bg-[oklch(0.7278_0.151_289/0.15)]";
const GLOBAL_SECTION_MENU_ITEM_CLASS =
  "text-[oklch(0.45_0.15_289)] focus:bg-[oklch(0.7278_0.151_289/0.12)] focus:text-[oklch(0.45_0.15_289)] dark:text-[oklch(0.78_0.15_289)] dark:focus:bg-[oklch(0.7278_0.151_289/0.15)] dark:focus:text-[oklch(0.78_0.15_289)] [&_svg]:!text-[oklch(0.7278_0.151_289)]";

interface SectionEntry {
  id: string;
  section: ParsedSection;
}

function createEntries(sections: ParsedSection[]): SectionEntry[] {
  return sections.map((section, index) => ({
    id: crypto.randomUUID(),
    section: { ...section, index },
  }));
}

function remapEntryIndices(entries: SectionEntry[]): SectionEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    section: { ...entry.section, index },
  }));
}

function SectionRowContent({ section }: { section: ParsedSection }) {
  const saved = section.isSavedBlock === true;
  const multivariate = section.isMultivariate === true;

  return (
    <>
      <DotsGrid className="h-4 w-4 shrink-0 text-muted-foreground/40" />
      <LayoutAlt01
        className="h-4 w-4 shrink-0"
        style={
          saved
            ? { color: GLOBAL_SECTION_ICON_COLOR }
            : multivariate
              ? { color: "oklch(0.65 0.15 160)" }
              : undefined
        }
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm font-medium",
          section.isHidden && "line-through opacity-50",
        )}
      >
        {section.label}
      </span>
      {section.isHidden ? (
        <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 opacity-0 group-hover:opacity-100" />
      )}
      {section.isLazy && (
        <Zap className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
      )}
    </>
  );
}

function sectionRowClassName(section: ParsedSection, selected: boolean) {
  const saved = section.isSavedBlock === true;
  const multivariate = section.isMultivariate === true;

  return cn(
    "group flex select-none items-center gap-2 rounded-md px-2 py-2.5",
    selected
      ? "bg-accent text-accent-foreground"
      : saved
        ? GLOBAL_SECTION_ROW_CLASS
        : multivariate
          ? "text-[oklch(0.45_0.15_160)] hover:bg-[oklch(0.65_0.15_160/0.12)] dark:text-[oklch(0.78_0.15_160)] dark:hover:bg-[oklch(0.65_0.15_160/0.15)]"
          : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
  );
}

// ─── sortable item ──────────────────────────────────────────────────────────────

function SortableSectionItem({
  section,
  sortableId,
  selected,
  onSelect,
  onDelete,
  onDuplicate,
  onMakeReusable,
}: {
  section: ParsedSection;
  sortableId: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMakeReusable: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({
      id: sortableId,
      animateLayoutChanges: () => false,
    });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, x: 0 } : null,
    ),
    opacity: isDragging ? 0 : undefined,
  };

  const enableMakeReusable = canMakeSectionReusable(section);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "touch-none transition-colors",
        isDragging ? "cursor-grabbing" : "cursor-pointer",
        sectionRowClassName(section, selected),
      )}
    >
      <SectionRowContent section={section} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Open actions for ${section.label}`}
            className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DotsHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {enableMakeReusable && (
            <DropdownMenuItem
              className={GLOBAL_SECTION_MENU_ITEM_CLASS}
              onClick={(e) => {
                e.stopPropagation();
                onMakeReusable();
              }}
            >
              <LayoutAlt01 size={14} />
              Save as global
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
          >
            <Copy01 size={14} />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash01 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── component ─────────────────────────────────────────────────────────────────

export function SectionList({
  listKey,
  sections,
  selectedIndex,
  onSelect,
  onReorder,
  onDelete,
  onDuplicate,
  onMakeReusable,
  onAddSection,
  canAddSection = true,
}: {
  listKey: string;
  sections: ParsedSection[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onDelete: (index: number) => void;
  onDuplicate: (index: number) => void;
  onMakeReusable: (index: number) => void;
  onAddSection: () => void;
  canAddSection?: boolean;
}) {
  const [entries, setEntries] = useState<SectionEntry[]>(() =>
    createEntries(sections),
  );
  const [activeEntry, setActiveEntry] = useState<SectionEntry | null>(null);
  const [prevListKey, setPrevListKey] = useState(listKey);
  const [prevSectionCount, setPrevSectionCount] = useState(sections.length);
  const [prevDisplayKey, setPrevDisplayKey] = useState(() =>
    sectionsDisplayKey(sections),
  );
  const suppressClickRef = useRef(false);

  const displayKey = sectionsDisplayKey(sections);

  if (prevListKey !== listKey) {
    setPrevListKey(listKey);
    setPrevSectionCount(sections.length);
    setPrevDisplayKey(displayKey);
    setEntries(createEntries(sections));
  } else if (prevSectionCount !== sections.length) {
    setPrevSectionCount(sections.length);
    setPrevDisplayKey(displayKey);
    setEntries(createEntries(sections));
  } else if (prevDisplayKey !== displayKey) {
    setPrevDisplayKey(displayKey);
    setEntries((current) =>
      sections.map((section, index) => {
        const prior = current[index];
        return {
          id: prior?.id ?? crypto.randomUUID(),
          section: { ...section, index },
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
    onReorder?.(oldIndex, newIndex);
  };

  const handleDragCancel = () => {
    setActiveEntry(null);
  };

  const handleSelect = (index: number) => {
    if (suppressClickRef.current) return;
    onSelect(index);
  };

  if (entries.length === 0) {
    return (
      <div className="space-y-2">
        <p className="px-2 py-3 text-xs text-muted-foreground">
          No sections in this page.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!canAddSection}
          onClick={onAddSection}
        >
          <Plus size={14} />
          Add section
        </Button>
      </div>
    );
  }

  return (
    <div className={activeEntry ? "cursor-grabbing" : undefined}>
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
          <div className="space-y-1">
            {entries.map((entry) => (
              <SortableSectionItem
                key={entry.id}
                sortableId={entry.id}
                section={entry.section}
                selected={selectedIndex === entry.section.index}
                onSelect={() => handleSelect(entry.section.index)}
                onDelete={() => onDelete(entry.section.index)}
                onDuplicate={() => onDuplicate(entry.section.index)}
                onMakeReusable={() => onMakeReusable(entry.section.index)}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeEntry ? (
            <div
              className={cn(
                "cursor-grabbing shadow-lg ring-1 ring-border/60",
                sectionRowClassName(activeEntry.section, false),
              )}
            >
              <SectionRowContent section={activeEntry.section} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 w-full"
        disabled={!canAddSection}
        onClick={onAddSection}
      >
        <Plus size={14} />
        Add section
      </Button>
    </div>
  );
}
