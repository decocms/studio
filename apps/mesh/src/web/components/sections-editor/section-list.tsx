import { useRef, useState } from "react";
import { cn } from "@deco/ui/lib/utils.js";
import {
  Copy01,
  DotsGrid,
  DotsHorizontal,
  Eye,
  EyeOff,
  LayoutAlt01,
  Trash01,
  Zap,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
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

const GLOBAL_SECTION_ICON_COLOR = "oklch(0.7278 0.151 289)";
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

// ─── types ─────────────────────────────────────────────────────────────────────

export interface ParsedSection {
  index: number;
  resolveType: string;
  label: string;
  isLazy?: boolean;
  isHidden?: boolean;
  isSavedBlock?: boolean;
  isMultivariate?: boolean;
}

interface RawSection {
  __resolveType: string;
  section?: { __resolveType?: string };
  variants?: Array<{
    value?: Record<string, unknown>;
    rule?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

// ─── parsing helpers ───────────────────────────────────────────────────────────

const LAZY_SUFFIXES = [
  "website/sections/Rendering/Lazy.tsx",
  "website/sections/Rendering/SingleDeferred.tsx",
];

export function isLazyResolveType(rt: string): boolean {
  return LAZY_SUFFIXES.some((suffix) => rt.endsWith(suffix));
}

function labelFromResolveType(rt: string): string {
  const parts = rt.split("/");
  const filename = parts[parts.length - 1] ?? rt;
  return filename.replace(/\.(tsx|ts|jsx|js)$/, "") || rt;
}

/**
 * Parse raw decofile sections into display-ready entries with
 * isLazy / isHidden / isSavedBlock / isMultivariate flags.
 * Mirrors admin-mcp's `parseSectionsFromArray()`.
 */
export function parseSections(
  rawSections: RawSection[],
  decofile: Record<string, unknown>,
): ParsedSection[] {
  return rawSections.map((s, idx) => {
    const rt = s.__resolveType ?? "";
    const isLazy = isLazyResolveType(rt);

    // ── Saved block (named block ref — no "/" in resolveType) ────────
    if (!isLazy && rt !== "" && !rt.includes("/") && rt in decofile) {
      const resolvedBlock = decofile[rt] as Record<string, unknown> | undefined;
      const label =
        (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
        rt.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
        `Section ${idx + 1}`;
      return {
        index: idx,
        resolveType: rt,
        label,
        isLazy: false,
        isSavedBlock: true,
      };
    }

    // ── Multivariate detection ──────────────────────────────────────
    const innerSection = isLazy
      ? (s.section as RawSection | undefined)
      : undefined;
    const mvRt = isLazy ? (innerSection?.__resolveType ?? "") : rt;

    if (mvRt.includes("flags/multivariate")) {
      const mvObj = (isLazy ? innerSection : s) as RawSection;
      const rawVariants = Array.isArray(mvObj?.variants) ? mvObj.variants : [];

      // ── Hidden: single variant with "never" matcher ───────────────
      const NEVER_TYPES = ["website/matchers/never.ts"];
      if (
        rawVariants.length === 1 &&
        NEVER_TYPES.includes(
          (rawVariants[0]?.rule?.__resolveType as string) ?? "",
        )
      ) {
        const innerValue = (rawVariants[0]?.value ?? {}) as Record<
          string,
          unknown
        >;
        let innerRt = (innerValue.__resolveType as string) ?? "";
        const innerIsLazy = isLazyResolveType(innerRt);
        if (innerIsLazy) {
          const nested = innerValue.section as
            | Record<string, unknown>
            | undefined;
          innerRt = (nested?.__resolveType as string) ?? innerRt;
        }
        return {
          index: idx,
          resolveType: rt,
          label: labelFromResolveType(innerRt) || `Section ${idx + 1}`,
          isHidden: true,
          isLazy: innerIsLazy,
        };
      }

      // Regular multivariate
      const firstValueRt = (
        rawVariants[0]?.value as Record<string, unknown> | undefined
      )?.__resolveType as string | undefined;
      const sectionLabel = firstValueRt
        ? labelFromResolveType(firstValueRt)
        : "Section";
      return {
        index: idx,
        resolveType: rt,
        label: `Variants of ${sectionLabel}`,
        isMultivariate: true,
        isLazy,
      };
    }

    // ── Lazy-wrapped saved block (e.g. Lazy → Header) ──────────────
    const effectiveRt = isLazy ? (s.section?.__resolveType ?? rt) : rt;
    if (
      isLazy &&
      effectiveRt !== "" &&
      !effectiveRt.includes("/") &&
      effectiveRt in decofile
    ) {
      const resolvedBlock = decofile[effectiveRt] as
        | Record<string, unknown>
        | undefined;
      const label =
        (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
        effectiveRt
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()) ||
        `Section ${idx + 1}`;
      return {
        index: idx,
        resolveType: rt,
        label,
        isLazy: true,
        isSavedBlock: true,
      };
    }

    // ── Normal section (possibly lazy-wrapped) ──────────────────────
    return {
      index: idx,
      resolveType: rt,
      label: labelFromResolveType(effectiveRt) || `Section ${idx + 1}`,
      isLazy,
    };
  });
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
}: {
  listKey: string;
  sections: ParsedSection[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onDelete: (index: number) => void;
  onDuplicate: (index: number) => void;
  onMakeReusable: (index: number) => void;
}) {
  const [entries, setEntries] = useState<SectionEntry[]>(() =>
    createEntries(sections),
  );
  const [activeEntry, setActiveEntry] = useState<SectionEntry | null>(null);
  const [prevListKey, setPrevListKey] = useState(listKey);
  const [prevSectionCount, setPrevSectionCount] = useState(sections.length);
  const suppressClickRef = useRef(false);

  if (prevListKey !== listKey) {
    setPrevListKey(listKey);
    setPrevSectionCount(sections.length);
    setEntries(createEntries(sections));
  } else if (prevSectionCount !== sections.length) {
    setPrevSectionCount(sections.length);
    setEntries(createEntries(sections));
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
      <p className="text-xs text-muted-foreground px-2 py-3">
        No sections in this page.
      </p>
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
    </div>
  );
}
