import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SORTABLE_DROP_ANIMATION } from "@/lib/dnd-drop-animation.ts";
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

// Width/margin snap instantly (no visible slide) while opacity does the
// actual animating. On reveal the snap has no delay, so the button is
// already full-size before opacity starts rising. On hide the snap is
// delayed until the fade-out finishes, so it's invisible when it happens.
//
// This button is toggled on (async render / hidden) — always shown, no
// hover dependency.
const ACTION_BUTTON_SHOWN =
  "w-7 ml-0 opacity-100 [transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]";
// No button on this row is toggled on — everyone starts fully collapsed
// (zero width) so the label gets the space, and hover reveals the whole
// group. group-has-[:focus-visible] (not group-focus-within) so keyboard
// Tab reveals it too, without a mouse click sticking it open (clicking a
// <button> focuses it, but doesn't count as :focus-visible).
const ACTION_BUTTON_HIDDEN =
  "w-0 -ml-2 opacity-0 [transition:opacity_150ms_ease-out,width_0ms_150ms,margin-left_0ms_150ms] " +
  "group-hover:ml-0 group-hover:w-7 group-hover:opacity-100 group-hover:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms] " +
  "group-has-[:focus-visible]:ml-0 group-has-[:focus-visible]:w-7 group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]";
// A sibling button on this row IS toggled on, so the whole action-button
// group already reserves its width — this button just isn't the active
// one. Stay at full width and only fade opacity, so a sibling toggling on
// or off never shifts this button (or the label) horizontally.
const ACTION_BUTTON_RESERVED_HIDDEN =
  "w-7 ml-0 opacity-0 [transition:opacity_150ms_ease-out,width_0ms_150ms,margin-left_0ms_150ms] " +
  "group-hover:opacity-100 group-has-[:focus-visible]:opacity-100";

// `reserved`: true when ANY button on this row is toggled on, so the whole
// group keeps its reserved width even for the buttons that aren't
// themselves active. `active`: this specific button is toggled on.
function actionButtonVisibilityClass(reserved: boolean, active: boolean) {
  return cn(
    "h-7 shrink-0 overflow-hidden",
    active
      ? ACTION_BUTTON_SHOWN
      : reserved
        ? ACTION_BUTTON_RESERVED_HIDDEN
        : ACTION_BUTTON_HIDDEN,
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
  const isHidden = section.isHidden === true;
  const reserveActionButtonSpace = isAsyncRender || isHidden;
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
                actionButtonVisibilityClass(
                  reserveActionButtonSpace,
                  isAsyncRender,
                ),
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
                isHidden
                  ? t("sectionsEditor.sectionList.showSection")
                  : t("sectionsEditor.sectionList.hideSection")
              }
              className={cn(
                actionButtonVisibilityClass(reserveActionButtonSpace, isHidden),
              )}
              onClick={(e) => {
                e.stopPropagation();
                onToggleHidden();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {isHidden ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isHidden
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
            className={cn(
              actionButtonVisibilityClass(reserveActionButtonSpace, false),
              "data-[state=open]:ml-0 data-[state=open]:w-7 data-[state=open]:opacity-100 data-[state=open]:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]",
            )}
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

        {/* Portal to body so the overlay's `position: fixed` resolves against
            the viewport, not the workspace PanelCard's `transform:
            translateZ(0)` containing block (which would drop the dragged row
            below the cursor). */}
        {createPortal(
          <DragOverlay dropAnimation={SORTABLE_DROP_ANIMATION}>
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
          </DragOverlay>,
          document.body,
        )}
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
