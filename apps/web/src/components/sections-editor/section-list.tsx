import { useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";
import { SORTABLE_DROP_ANIMATION } from "@/lib/dnd-drop-animation.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useCompactPageLayout } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Copy01,
  Cube01,
  LayersThree01,
  Globe01,
  DotsGrid,
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
  DropdownMenuSeparator,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
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
  EditorRowActionsTrigger,
  EditorRowToggle,
  editorRowClassName,
} from "./editor-list-row";
import { VARIANT_MENU_ITEM_CLASS } from "./section-variant-list";
import { canAddSectionVariant } from "./section-variants";
import { isLazyResolveType } from "./section-lazy";
import { getSectionPreviewImageSrc } from "./section-preview-image";
import { getSectionDisplayTitle } from "./section-title";
import type { LiveMeta } from "./resolve-schema";
import { GLOBAL_SECTION_ICON_COLOR, type RawSection } from "./section-types";
import { parseSections, type ParsedSection } from "./parse-sections";
import { sectionHasMissingRequiredField } from "./section-required-status";
import { MissingRequiredMarker } from "./missing-required-marker";

export { parseSections, type ParsedSection, type RawSection };

/** A row's status marker: one glyph, tinted by severity, naming itself on
 *  hover. Read-only — every action on the row lives in its menu. */
function RowStatusIcon({
  icon: Icon,
  label,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className="shrink-0 cursor-help">
          <Icon className={cn("size-3.5", className)} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">{label}</TooltipContent>
    </Tooltip>
  );
}

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
  decofile,
}: {
  section: ParsedSection;
  raw: RawSection | undefined;
  meta: LiveMeta | null | undefined;
  decofile: Record<string, unknown>;
}) {
  const t = useT();
  const compact = useCompactPageLayout();
  const saved = section.isSavedBlock === true;
  const multivariate = section.isMultivariate === true;
  const imageSrc =
    raw && meta ? getSectionPreviewImageSrc(raw, meta) : undefined;
  // Saved blocks / multivariate rows carry their own intentional labels.
  const dynamicTitle =
    raw && meta && !saved && !multivariate
      ? getSectionDisplayTitle(raw, meta)
      : undefined;
  const missingRequired = sectionHasMissingRequiredField(
    raw,
    section,
    decofile,
    meta,
  );
  const asyncRender =
    !multivariate && isLazyResolveType(raw?.__resolveType ?? "");

  /** Compact only: one icon per concept, the same one the rest of the UI uses
   *  — a globe for a section shared across the site, the stacked cube for a
   *  block that has variants, the plain cube for everything else. */
  const RowIcon = saved ? Globe01 : multivariate ? LayersThree01 : Cube01;
  const iconStyle = saved
    ? { color: GLOBAL_SECTION_ICON_COLOR }
    : multivariate
      ? { color: "oklch(0.65 0.15 160)" }
      : undefined;

  return (
    <>
      {compact ? (
        /* The block icon and the drag grip share one fixed slot: icon at rest,
           grip on hover or keyboard focus. Only ever one is painted, so the
           swap never shifts the label. */
        <span className="relative size-4 shrink-0">
          <RowIcon className="absolute inset-0 size-4 text-muted-foreground transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0" />
          <GripVertical
            aria-hidden
            className="absolute inset-0 size-4 opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
          />
        </span>
      ) : (
        <DotsGrid className="h-4 w-4 shrink-0 text-muted-foreground/40" />
      )}
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="h-12 max-w-[100px] shrink-0 rounded object-cover"
        />
      )}
      {!compact && (
        <LayoutAlt01 className="h-4 w-4 shrink-0" style={iconStyle} />
      )}
      <span
        className={cn(
          "min-w-0 truncate text-sm font-medium",
          compact ? "shrink" : "flex-1",
          section.isHidden && "line-through opacity-50",
        )}
      >
        {dynamicTitle ?? section.label}
      </span>
      {compact ? (
        <>
          {asyncRender && (
            <RowStatusIcon
              icon={Zap}
              label={t("sectionsEditor.sectionList.asyncBadge")}
              className="text-muted-foreground"
            />
          )}
          {missingRequired && <MissingRequiredMarker />}
          {/* Takes the slack so status sits against the title, actions stay right. */}
          <span className="min-w-0 flex-1" />
        </>
      ) : (
        missingRequired && (
          <MissingRequiredMarker className="absolute -right-0.5 -top-0.5" />
        )
      )}
    </>
  );
}

const GLOBAL_SECTION_ROW_CLASS =
  "text-global-section-fg hover:bg-global-section/12 dark:text-global-section-fg-dark dark:hover:bg-global-section/15";
const VARIANT_ROW_CLASS =
  "text-[oklch(0.45_0.15_160)] hover:bg-[oklch(0.65_0.15_160/0.12)] dark:text-[oklch(0.78_0.15_160)] dark:hover:bg-[oklch(0.65_0.15_160/0.15)]";

/** Compact reads type from the row's icon and status from its markers, so the
 *  row itself only has to show selection. Classic tints the whole row by type. */
function sectionRowClassName(
  section: ParsedSection,
  selected: boolean,
  compact: boolean,
) {
  if (compact) return editorRowClassName({ selected });

  const saved = section.isSavedBlock === true;
  const multivariate = section.isMultivariate === true;

  return cn(
    "group relative flex select-none items-center gap-2 rounded-md px-2 py-2.5",
    selected
      ? "bg-accent text-accent-foreground"
      : saved
        ? GLOBAL_SECTION_ROW_CLASS
        : multivariate
          ? VARIANT_ROW_CLASS
          : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
  );
}

/** Classic's action-button reveal: width and margin snap with no visible
 *  slide while opacity carries the animation, so a toggle never shifts the
 *  row's label. `reserved` means some button on the row is toggled on, so the
 *  group holds its width; `active` means this button is that one. */
function actionButtonVisibilityClass(reserved: boolean, active: boolean) {
  const shown =
    "w-7 ml-0 opacity-100 [transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]";
  const reservedHidden =
    "w-7 ml-0 opacity-0 [transition:opacity_150ms_ease-out,width_0ms_150ms,margin-left_0ms_150ms] " +
    "group-hover:opacity-100 group-has-[:focus-visible]:opacity-100";
  const hidden =
    "w-0 -ml-2 opacity-0 [transition:opacity_150ms_ease-out,width_0ms_150ms,margin-left_0ms_150ms] " +
    "group-hover:ml-0 group-hover:w-7 group-hover:opacity-100 group-hover:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms] " +
    "group-has-[:focus-visible]:ml-0 group-has-[:focus-visible]:w-7 group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]";

  return cn(
    "h-7 shrink-0 overflow-hidden",
    active ? shown : reserved ? reservedHidden : hidden,
  );
}

// ─── sortable item ──────────────────────────────────────────────────────────────

function SortableSectionItem({
  section,
  raw,
  meta,
  decofile,
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
  decofile: Record<string, unknown>;
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
  const compact = useCompactPageLayout();
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
        sectionRowClassName(section, selected, compact),
      )}
    >
      <SectionRowContent
        section={section}
        raw={raw}
        meta={meta}
        decofile={decofile}
      />

      {!compact && !section.isMultivariate && (
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
                className={cn("h-3.5 w-3.5", isAsyncRender && "text-warning")}
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

      {compact ? (
        <EditorRowToggle
          label={
            isHidden
              ? t("sectionsEditor.sectionList.showSection")
              : t("sectionsEditor.sectionList.hideSection")
          }
          active={isHidden}
          onToggle={onToggleHidden}
        >
          {isHidden ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </EditorRowToggle>
      ) : (
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
        <EditorRowActionsTrigger
          label={t("sectionsEditor.sectionList.sectionActionsMenu")}
          classicClassName={cn(
            actionButtonVisibilityClass(reserveActionButtonSpace, false),
            "data-[state=open]:ml-0 data-[state=open]:w-7 data-[state=open]:opacity-100 data-[state=open]:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]",
          )}
        />
        <DropdownMenuContent align="end" className="w-44">
          {/* Classic keeps async rendering on its own row button. */}
          {compact && !section.isMultivariate && (
            <>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLazy();
                }}
              >
                <Zap className="h-4 w-4" />
                {isAsyncRender
                  ? t("sectionsEditor.sectionList.disableAsyncRender")
                  : t("sectionsEditor.sectionList.enableAsyncRender")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
              className={cn(!compact && VARIANT_MENU_ITEM_CLASS)}
              onClick={(e) => {
                e.stopPropagation();
                onAddVariant();
              }}
            >
              <LayersThree01 className="h-4 w-4" />
              {t("sectionsEditor.sectionList.addVariantMenuItem")}
            </DropdownMenuItem>
          )}
          {enableMakeReusable && (
            <DropdownMenuItem
              className={cn(!compact && GLOBAL_SECTION_MENU_ITEM_CLASS)}
              onClick={(e) => {
                e.stopPropagation();
                onMakeReusable();
              }}
            >
              {compact ? (
                <Globe01 className="h-4 w-4" />
              ) : (
                <LayoutAlt01 className="h-4 w-4" />
              )}
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
              {compact ? (
                <Cube01 className="h-4 w-4" />
              ) : (
                <LayoutAlt01 className="h-4 w-4" />
              )}
              {t("sectionsEditor.sectionList.detachMenuItem")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
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

/** Pinned to the panel's foot by the caller, so it stays put while the list
 *  scrolls. Radius is left to the Button so `--studio-button-radius` still
 *  makes it a pill in the compact layout. */
export function AddSectionButton({
  canAddSection,
  onAddSection,
  className,
  size,
}: {
  canAddSection: boolean;
  onAddSection: () => void;
  className?: string;
  size?: "sm";
}) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={cn("w-full", className)}
      disabled={!canAddSection}
      onClick={onAddSection}
    >
      <Plus size={14} />
      {t("sectionsEditor.sectionList.addSectionButton")}
    </Button>
  );
}

export function SectionList({
  listKey,
  rawSections,
  sections,
  meta,
  decofile,
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
  decofile: Record<string, unknown>;
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
  /** Classic only: compact pins the add button to the panel's foot instead. */
  onAddSection: () => void;
  canAddSection?: boolean;
}) {
  const t = useT();
  const compact = useCompactPageLayout();
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
    const empty = (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        {t("sectionsEditor.sectionList.noSections")}
      </p>
    );
    return compact ? (
      empty
    ) : (
      <div className="space-y-2">
        {empty}
        <AddSectionButton
          canAddSection={canAddSection}
          onAddSection={onAddSection}
          size="sm"
        />
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
          <div className={cn(compact ? "space-y-0" : "space-y-1")}>
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
                  decofile={decofile}
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
            the viewport, not the workspace Panel's `transform:
            translateZ(0)` containing block (which would drop the dragged row
            below the cursor). */}
        {createPortal(
          <DragOverlay dropAnimation={SORTABLE_DROP_ANIMATION}>
            {activeSection ? (
              <div
                className={cn(
                  "cursor-grabbing shadow-lg ring-1 ring-border/60",
                  sectionRowClassName(activeSection, false, compact),
                )}
              >
                <SectionRowContent
                  section={activeSection}
                  raw={activeRaw}
                  meta={meta}
                  decofile={decofile}
                />
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      {!compact && (
        <AddSectionButton
          canAddSection={canAddSection}
          onAddSection={onAddSection}
          size="sm"
          className="mt-2"
        />
      )}
    </div>
  );
}
