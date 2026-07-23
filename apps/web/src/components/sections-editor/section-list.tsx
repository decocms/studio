import { useRef, useState } from "react";
import { cn } from "@deco/ui/lib/utils.js";
import { useT } from "@/i18n/use-t.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Copy01,
  DotsGrid,
  DotsHorizontal,
  Eye,
  EyeOff,
  Flag01,
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
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
import { VARIANT_MENU_ITEM_CLASS } from "./section-variant-list";
import { canAddSectionVariant } from "./section-variants";
import { isLazyResolveType } from "./section-lazy";
import { getSectionPreviewImageSrc } from "./section-preview-image";
import type { LiveMeta } from "./resolve-schema";
import { GLOBAL_SECTION_ICON_COLOR, type RawSection } from "./section-types";
import { parseSections, type ParsedSection } from "./parse-sections";

export { parseSections, type ParsedSection, type RawSection };

const GLOBAL_SECTION_ROW_CLASS =
  "text-global-section-fg hover:bg-global-section/12 dark:text-global-section-fg-dark dark:hover:bg-global-section/15";
const GLOBAL_SECTION_MENU_ITEM_CLASS =
  "text-global-section-fg focus:bg-global-section/12 focus:text-global-section-fg dark:text-global-section-fg-dark dark:focus:bg-global-section/15 dark:focus:text-global-section-fg-dark [&_svg]:!text-global-section";

/** Stable DnD id per row; section display data always comes from `sections` prop. */
interface SectionEntry {
  id: string;
  index: number;
}

function createEntries(count: number): SectionEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    index,
  }));
}

function remapEntryIndices(entries: SectionEntry[]): SectionEntry[] {
  return entries.map((entry, index) => ({ ...entry, index }));
}

function resizeEntries(
  current: SectionEntry[],
  nextCount: number,
): SectionEntry[] {
  if (nextCount === current.length) return current;
  if (nextCount < current.length) {
    return remapEntryIndices(current.slice(0, nextCount));
  }
  const extra = Array.from(
    { length: nextCount - current.length },
    (_, offset) => ({
      id: crypto.randomUUID(),
      index: current.length + offset,
    }),
  );
  return [...current, ...extra];
}

function SectionRowContent({
  section,
  raw,
  meta,
}: {
  section: ParsedSection;
  raw: RawSection | undefined;
  meta: LiveMeta | null | undefined;
}) {
  const saved = section.isSavedBlock === true;
  const multivariate = section.isMultivariate === true;
  const imageSrc =
    raw && meta ? getSectionPreviewImageSrc(raw, meta) : undefined;

  return (
    <>
      <DotsGrid className="h-4 w-4 shrink-0 text-muted-foreground/40" />
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="h-12 max-w-[100px] shrink-0 rounded object-cover"
        />
      )}
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
  raw,
  meta,
  sortableId,
  selected,
  onSelect,
  onDelete,
  onDuplicate,
  onMakeReusable,
  onToggleHidden,
  onToggleLazy,
  onAddVariant,
  onDetach,
}: {
  section: ParsedSection;
  raw: RawSection | undefined;
  meta: LiveMeta | null | undefined;
  sortableId: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMakeReusable: () => void;
  onToggleHidden: () => void;
  onToggleLazy: () => void;
  onAddVariant: () => void;
  onDetach: () => void;
}) {
  const t = useT();
  const isAsyncRender = raw
    ? isLazyResolveType(raw.__resolveType ?? "")
    : false;
  const enableAddVariant = canAddSectionVariant(section);
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
      <SectionRowContent section={section} raw={raw} meta={meta} />

      {!section.isMultivariate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                isAsyncRender
                  ? t("sectionsEditor.sectionList.disableAsyncRender")
                  : t("sectionsEditor.sectionList.enableAsyncRender")
              }
              className={cn(
                "h-7 w-7 shrink-0",
                isAsyncRender ? "" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onToggleLazy();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Zap
                className={cn(
                  "h-3.5 w-3.5",
                  isAsyncRender && "text-yellow-500",
                )}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isAsyncRender
              ? t("sectionsEditor.sectionList.disableAsyncRender")
              : t("sectionsEditor.sectionList.enableAsyncRender")}
          </TooltipContent>
        </Tooltip>
      )}

      {!section.isMultivariate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                section.isHidden
                  ? t("sectionsEditor.sectionList.showSection")
                  : t("sectionsEditor.sectionList.hideSection")
              }
              className={cn(
                "h-7 w-7 shrink-0",
                section.isHidden
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onToggleHidden();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {section.isHidden ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {section.isHidden
              ? t("sectionsEditor.sectionList.showSection")
              : t("sectionsEditor.sectionList.hideSection")}
          </TooltipContent>
        </Tooltip>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("sectionsEditor.sectionList.sectionActionsMenu")}
            className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DotsHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
          >
            <Copy01 className="h-4 w-4" />
            {t("sectionsEditor.sectionList.duplicateMenuItem")}
          </DropdownMenuItem>
          {enableAddVariant && (
            <DropdownMenuItem
              className={VARIANT_MENU_ITEM_CLASS}
              onClick={(e) => {
                e.stopPropagation();
                onAddVariant();
              }}
            >
              <Flag01 className="h-4 w-4" />
              {t("sectionsEditor.sectionList.addVariantMenuItem")}
            </DropdownMenuItem>
          )}
          {enableMakeReusable && (
            <DropdownMenuItem
              className={GLOBAL_SECTION_MENU_ITEM_CLASS}
              onClick={(e) => {
                e.stopPropagation();
                onMakeReusable();
              }}
            >
              <LayoutAlt01 className="h-4 w-4" />
              {t("sectionsEditor.sectionList.makeReusableMenuItem")}
            </DropdownMenuItem>
          )}
          {section.isSavedBlock === true && !section.isMultivariate && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDetach();
              }}
            >
              <LayoutAlt01 className="h-4 w-4" />
              {t("sectionsEditor.sectionList.detachMenuItem")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash01 className="h-4 w-4" />
            {t("sectionsEditor.sectionList.deleteMenuItem")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── component ─────────────────────────────────────────────────────────────────

export function SectionList({
  listKey,
  rawSections,
  sections,
  meta,
  selectedIndex,
  onSelect,
  onReorder,
  onDelete,
  onDuplicate,
  onMakeReusable,
  onToggleHidden,
  onToggleLazy,
  onAddVariant,
  onDetach,
  onAddSection,
  canAddSection = true,
}: {
  listKey: string;
  rawSections: RawSection[];
  sections: ParsedSection[];
  meta: LiveMeta | null | undefined;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onDelete: (index: number) => void;
  onDuplicate: (index: number) => void;
  onMakeReusable: (index: number) => void;
  onToggleHidden: (index: number) => void;
  onToggleLazy: (index: number) => void;
  onAddVariant: (index: number) => void;
  onDetach: (index: number) => void;
  onAddSection: () => void;
  canAddSection?: boolean;
}) {
  const t = useT();
  const [entries, setEntries] = useState<SectionEntry[]>(() =>
    createEntries(sections.length),
  );
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [prevListKey, setPrevListKey] = useState(listKey);
  const [prevSectionCount, setPrevSectionCount] = useState(sections.length);
  const suppressClickRef = useRef(false);

  if (prevListKey !== listKey) {
    setPrevListKey(listKey);
    setPrevSectionCount(sections.length);
    setEntries(createEntries(sections.length));
  } else if (prevSectionCount !== sections.length) {
    setPrevSectionCount(sections.length);
    setEntries((current) => resizeEntries(current, sections.length));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const entryIds = entries.map((entry) => entry.id);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveEntryId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveEntryId(null);

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
    setActiveEntryId(null);
  };

  const handleSelect = (index: number) => {
    if (suppressClickRef.current) return;
    onSelect(index);
  };

  const activeEntry = activeEntryId
    ? entries.find((entry) => entry.id === activeEntryId)
    : null;
  const activeSection =
    activeEntry != null ? sections[activeEntry.index] : null;
  const activeRaw =
    activeEntry != null ? rawSections[activeEntry.index] : undefined;

  if (entries.length === 0) {
    return (
      <div className="space-y-2">
        <p className="px-2 py-3 text-xs text-muted-foreground">
          {t("sectionsEditor.sectionList.noSections")}
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
          {t("sectionsEditor.sectionList.addSectionButton")}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn(activeEntry && "cursor-grabbing")}>
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
            {entries.map((entry) => {
              const section = sections[entry.index];
              if (!section) return null;

              return (
                <SortableSectionItem
                  key={entry.id}
                  sortableId={entry.id}
                  section={section}
                  raw={rawSections[entry.index]}
                  meta={meta}
                  selected={selectedIndex === entry.index}
                  onSelect={() => handleSelect(entry.index)}
                  onDelete={() => onDelete(entry.index)}
                  onDuplicate={() => onDuplicate(entry.index)}
                  onMakeReusable={() => onMakeReusable(entry.index)}
                  onToggleHidden={() => onToggleHidden(entry.index)}
                  onToggleLazy={() => onToggleLazy(entry.index)}
                  onAddVariant={() => onAddVariant(entry.index)}
                  onDetach={() => onDetach(entry.index)}
                />
              );
            })}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeSection ? (
            <div
              className={cn(
                "cursor-grabbing shadow-lg ring-1 ring-border/60",
                sectionRowClassName(activeSection, false),
              )}
            >
              <SectionRowContent
                section={activeSection}
                raw={activeRaw}
                meta={meta}
              />
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
        {t("sectionsEditor.sectionList.addSectionButton")}
      </Button>
    </div>
  );
}
