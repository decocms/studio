import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { List, Plus, Rows01 } from "@untitledui/icons";
import { toast } from "sonner";
import { ViewModeToggle } from "@decocms/ui/components/view-mode-toggle.tsx";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useV8Editor } from "../v8-editor-context";
import { useNewBlocksEditor } from "@/hooks/use-new-blocks-editor";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { useT } from "@/i18n/use-t.ts";
import { AddListRow } from "../editor-list-row";
import { SORTABLE_DROP_ANIMATION } from "@/lib/dnd-drop-animation.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  getArrayItemDisplayLabels,
  getArrayItemImageSrc,
  getArrayItemLabel,
} from "../array-item-display";
import {
  arrayItemDisplayValue,
  hideArrayItem,
  isArrayItemHidden,
  showArrayItem,
} from "../array-item-hidden";
import { isEmbeddedUnionResolveType } from "../block-type-utils";
import {
  type Crumb,
  buildArrayDrillDownBreadcrumb,
  resolveArrayItemSelection,
  withItemCrumbLabel,
} from "../schema-form-breadcrumb";
import { isSectionArrayField } from "../section-array-field";
import {
  type ArrayEntry,
  createArrayEntries,
  insertEntryAfter,
  isNonArrayStoredValue,
  remapEntryIndices,
  removeEntryAt,
  resizeArrayEntries,
} from "./array-entries";
import {
  FieldDescriptionTooltip,
  useFieldDescriptionTooltips,
} from "./field-label";
import type { FieldProps } from "./field-props";
import {
  ARRAY_ROW_THUMBNAIL_HEIGHT,
  ArrayRowContent,
  SortableArrayRow,
} from "./array-row";
import { hasMissingRequiredField } from "../section-required-status";
import { MissingRequiredMarker } from "../missing-required-marker";
import { SchemaForm, renderField } from "../schema-form";
import {
  RequiredFieldProvider,
  useRequiredField,
} from "./required-field-context";
import { expandRecursiveSchema } from "./resolved-schema-cache";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "../resolve-schema";

/**
 * A default of `[]` is a NEW array on every render, so anything derived from
 * it re-renders even when nothing changed. `never[]` is assignable to any
 * `T[]`, so one frozen constant serves every optional list prop in this file.
 */
const EMPTY_ARRAY: never[] = [];

function itemEditorSchema(
  item: unknown,
  itemSchema: SchemaProperty | undefined,
  meta?: LiveMeta,
  containerResolveType?: string,
  arrayFieldKey?: string,
): SchemaProperty | undefined {
  if (
    itemSchema?.type === "object" &&
    itemSchema.properties &&
    Object.keys(itemSchema.properties).length > 0
  ) {
    return itemSchema;
  }
  if (itemSchema?.type === "block-ref" && itemSchema.anyOfRefs?.length) {
    return itemSchema;
  }
  if (item != null && typeof item === "object" && !Array.isArray(item)) {
    const resolveType = (item as Record<string, unknown>).__resolveType;
    if (typeof resolveType === "string" && meta) {
      const resolved = resolveSchema(resolveType, meta);
      if (resolved?.properties && Object.keys(resolved.properties).length > 0) {
        return resolved;
      }
    }
  }
  if (meta && containerResolveType && arrayFieldKey) {
    const container = resolveSchema(containerResolveType, meta);
    const itemsSchema = container?.properties?.[arrayFieldKey]?.items;
    if (
      itemsSchema?.properties &&
      Object.keys(itemsSchema.properties).length > 0
    ) {
      return {
        ...itemsSchema,
        titleBy: itemsSchema.titleBy ?? itemSchema?.titleBy,
      };
    }
  }
  return itemSchema;
}

/**
 * `drill` opens one item at a time in place of the list; `inline` expands
 * items under their rows so the list stays on screen between edits.
 */
type ArrayFieldLayout = "drill" | "inline";

function arrayFieldKeyFromPath(path: string): string {
  const segments = path.split(".").filter((segment) => !/^\d+$/.test(segment));
  return segments[segments.length - 1] ?? path;
}

export function ArrayField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath = EMPTY_ARRAY,
  onBreadcrumbChange,
  hasSiblingDrillDownFields,
  meta,
  decofile,
  onSaveReferencedBlock,
  containerResolveType,
  previewBaseUrl,
  onAddSectionItem,
  onRequestAddSection,
  sandbox,
}: FieldProps) {
  const v8 = useV8Editor();
  const t = useT();
  const compact = useNewBlocksEditor();
  const tooltipsEnabled = useFieldDescriptionTooltips(sandbox?.virtualMcpId);
  const { required: requiredProp, invalid: requiredInvalid } =
    useRequiredField();
  const items = Array.isArray(value) ? value : [];
  const itemSchema = expandRecursiveSchema(schema.items, meta);
  const arrayFieldKey = arrayFieldKeyFromPath(path);
  // Options that let buildArrayDrillDownBreadcrumb decide whether this array's
  // own label must stay in the trail to keep the item uniquely addressable.
  const drillDownOpts = {
    arrayKey: arrayFieldKey,
    hasSiblingDrillDownFields,
    // Schema-only item labels (titleBy / inline-union) can't be recomputed by a parent loader's resolver, so keep the array label folded as the disambiguator.
    itemLabelFromSchema: Boolean(
      itemSchema?.titleBy || itemSchema?.inlineUnionBranches?.length,
    ),
  };
  const usesSectionPicker = isSectionArrayField(schema, arrayFieldKey);
  const hasThumbnails = items.some((item) =>
    Boolean(getArrayItemImageSrc(arrayItemDisplayValue(item, v8), itemSchema)),
  );
  // Only plain object arrays (banners, links, …) get the hide toggle. Section
  // pickers have their own hide flow, and primitive arrays can't be wrapped.
  const canHideItems = !usesSectionPicker && itemSchema?.type === "object";
  // Section lists keep drilling in: each section is a whole form of its own.
  const canEditInline = !usesSectionPicker;
  const [layoutPreference, setLayoutPreference] =
    useLocalStorage<ArrayFieldLayout>(
      LOCALSTORAGE_KEYS.arrayFieldLayout(),
      "drill",
    );
  const inline = canEditInline && layoutPreference === "inline";
  // Index of the item the user has explicitly opened. The breadcrumb crumb
  // carries the item's index (see `Crumb`), so selection survives a remount on
  // its own; this preferred index is only a churn-window fallback that pins the
  // open row while an edit briefly changes its label.
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const selection = resolveArrayItemSelection(
    label,
    breadcrumbPath,
    items,
    itemSchema,
    openIndex,
    arrayFieldKey,
  );
  const selectedIndex = selection?.index ?? null;

  // Keep the tracked index in step with the breadcrumb: forget it once the
  // breadcrumb no longer opens an item here, and adopt the resolved index when
  // navigation opened an item some other way (header/breadcrumb click, deep link).
  //
  // This set-state-during-render reconciliation converges in one extra render
  // because `resolveArrayItemSelection` returns `preferredIndex` only when that
  // item still matches the winning crumb: adopting the resolved index yields a
  // fixed point on the next render (no oscillation). `openIndex` is a raw index
  // (not tied to the stable `entries` ids), which is safe only because every
  // index-shifting mutation (reorder, duplicate, remove) is reachable exclusively
  // from the list view below — where `selection` is null and `openIndex` has
  // already been forced back to null.
  if (selection === null) {
    if (openIndex !== null) setOpenIndex(null);
  } else if (selection.index !== openIndex) {
    setOpenIndex(selection.index);
  }

  const [entries, setEntries] = useState<ArrayEntry[]>(() =>
    createArrayEntries(items.length),
  );
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [expandedEntryIds, setExpandedEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [prevListKey, setPrevListKey] = useState(path);
  const [prevItemCount, setPrevItemCount] = useState(items.length);
  const suppressClickRef = useRef(false);
  /**
   * The open item's freshest display label, stashed by `updateItem` so the
   * nested-field breadcrumb rebuild (`arrayItemPrefix`) can carry it before the
   * edited value re-renders this array — otherwise the item crumb keeps the
   * label it had at drill-in time (the duplicated-from value the user saw stuck
   * in the breadcrumb). Keyed by `path` + `index` so a reused instance driving a
   * different array (or a different open row) never serves a foreign label.
   */
  const openItemLabelRef = useRef<{
    path: string;
    index: number;
    label: string;
  } | null>(null);

  if (prevListKey !== path) {
    setPrevListKey(path);
    setPrevItemCount(items.length);
    setEntries(createArrayEntries(items.length));
    setExpandedEntryIds(new Set());
    setOpenIndex(null);
  } else if (prevItemCount !== items.length) {
    setPrevItemCount(items.length);
    setEntries((current) => resizeArrayEntries(current, items.length));
  }

  // The item's base (un-suffixed) label — the crumb carries the index for
  // addressing, so the label is display-only and must stay clean.
  const itemLabel = (item: unknown, index: number) =>
    getArrayItemLabel(arrayItemDisplayValue(item, v8), index, itemSchema);

  const openItem = (index: number) => {
    if (suppressClickRef.current) return;
    const labelText = itemLabel(items[index], index);
    setOpenIndex(index);
    onBreadcrumbChange?.(
      buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        labelText,
        index,
        drillDownOpts,
      ),
    );
  };

  const toggleEntryExpanded = (entryId: string) => {
    if (suppressClickRef.current) return;
    setExpandedEntryIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const appendItem = (item: unknown) => {
    const next = [...items, item];
    onChange(next);
    const nextIndex = next.length - 1;
    setOpenIndex(nextIndex);
    const labelText = itemLabel(item, nextIndex);
    onBreadcrumbChange?.(
      buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        labelText,
        nextIndex,
        drillDownOpts,
      ),
    );
  };

  const addItem = () => {
    const t = itemSchema?.type;
    const defaultVal =
      itemSchema?.default !== undefined
        ? itemSchema.default
        : t === "object"
          ? {}
          : t === "block-ref"
            ? (() => {
                const rt = itemSchema?.anyOfRefs?.[0]?.resolveType;
                if (typeof rt !== "string" || isEmbeddedUnionResolveType(rt)) {
                  return {};
                }
                return { __resolveType: rt };
              })()
            : t === "number" || t === "integer"
              ? 0
              : t === "boolean"
                ? false
                : t === "array"
                  ? []
                  : "";
    const next = [...items, defaultVal];
    onChange(next);
    if (inline) {
      const grown = resizeArrayEntries(entries, next.length);
      const added = grown[grown.length - 1];
      setEntries(grown);
      if (added) {
        setExpandedEntryIds((current) => new Set(current).add(added.id));
      }
      return;
    }
    const nextIndex = next.length - 1;
    setOpenIndex(nextIndex);
    const labelText = itemLabel(defaultVal, nextIndex);
    onBreadcrumbChange?.(
      buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        labelText,
        nextIndex,
        drillDownOpts,
      ),
    );
  };

  const handleAddClick = () => {
    if (usesSectionPicker) {
      if (!previewBaseUrl) {
        toast.error(t("sectionsEditor.arrayField.startPreviewServer"));
        return;
      }
      if (onRequestAddSection) {
        onRequestAddSection({ append: appendItem });
        return;
      }
      toast.error(t("sectionsEditor.arrayField.sectionPickerNotAvailable"));
      return;
    }
    addItem();
  };

  const duplicateItem = (index: number) => {
    const original = items[index];
    const copy =
      typeof structuredClone === "function"
        ? structuredClone(original)
        : JSON.parse(JSON.stringify(original ?? null));
    const next = [
      ...items.slice(0, index + 1),
      copy,
      ...items.slice(index + 1),
    ];
    onChange(next);
    setEntries((current) => insertEntryAfter(current, index));
  };

  const toggleItemHidden = (index: number) => {
    const item = items[index];
    const next = [...items];
    next[index] = isArrayItemHidden(item, v8)
      ? showArrayItem(item, v8)
      : hideArrayItem(item, meta);
    onChange(next);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    setEntries((current) => removeEntryAt(current, index));
  };

  const updateItem = (index: number, val: unknown) => {
    const next = [...items];
    // Preserve the hidden wrapper when editing a hidden item's inner value.
    next[index] = isArrayItemHidden(items[index], v8)
      ? hideArrayItem(val, meta)
      : val;
    onChange(next);

    // When editing the currently selected item, its display label may change
    // (e.g. editing the "alt" or "name" field that drives getArrayItemLabel).
    // Rewrite the item's crumb IN PLACE — at the position resolution matched it
    // (`selection.crumbIndex`) — keeping the same `itemIndex`. Syncing the label
    // part still matters: ownership resolution matches the crumb's label against
    // this array's current base labels, so a stale label would let the item
    // re-resolve to a colliding sibling (the "editing a duplicate snaps to the
    // original" bug).
    if (index === selectedIndex && selection) {
      const oldLabel = itemLabel(items[index], index);
      const newLabel = itemLabel(next[index], index);
      openItemLabelRef.current = { path, index, label: newLabel };
      if (oldLabel !== newLabel) {
        const updatedBreadcrumb = [...breadcrumbPath];
        updatedBreadcrumb[selection.crumbIndex] = withItemCrumbLabel(
          breadcrumbPath[selection.crumbIndex],
          newLabel,
          index,
        );
        onBreadcrumbChange?.(updatedBreadcrumb);
      }
    }
  };

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
    onChange(arrayMove([...items], oldIndex, newIndex));
    suppressClickRef.current = true;
    requestAnimationFrame(() => {
      suppressClickRef.current = false;
    });
  };

  const handleDragCancel = () => {
    setActiveEntryId(null);
  };

  const activeEntry = activeEntryId
    ? entries.find((entry) => entry.id === activeEntryId)
    : null;
  const activeItem = activeEntry != null ? items[activeEntry.index] : undefined;
  // Match the list row: the drag overlay is display only, so it shows the
  // un-disambiguated base label (no positional " N" suffix).
  const activeLabel =
    activeEntry != null && activeItem !== undefined
      ? getArrayItemDisplayLabels(items, itemSchema)[activeEntry.index]
      : null;
  const activeImage =
    activeEntry != null && activeItem !== undefined
      ? getArrayItemImageSrc(arrayItemDisplayValue(activeItem, v8), itemSchema)
      : undefined;

  /**
   * The editor for one item. `innerPath` is the trail below the item's own
   * crumb, and `itemPrefix` the trail through it, which nested fields prepend
   * their breadcrumb changes onto.
   */
  const renderItemEditor = (
    index: number,
    innerPath: Crumb[],
    itemPrefix: () => Crumb[],
  ) => {
    const item = arrayItemDisplayValue(items[index], v8);
    const editorSchema = itemEditorSchema(
      item,
      itemSchema,
      meta,
      containerResolveType,
      arrayFieldKey,
    );
    return (
      <div className="min-w-0">
        {editorSchema?.type === "object" && editorSchema.properties ? (
          <SchemaForm
            schema={editorSchema}
            value={item}
            onChange={(val) => updateItem(index, val)}
            basePath={`${path}.${index}`}
            breadcrumbPath={innerPath}
            onBreadcrumbChange={(nextPath) => {
              onBreadcrumbChange?.([...itemPrefix(), ...nextPath]);
            }}
            meta={meta}
            decofile={decofile}
            onSaveReferencedBlock={onSaveReferencedBlock}
            previewBaseUrl={previewBaseUrl}
            onAddSectionItem={onAddSectionItem}
            onRequestAddSection={onRequestAddSection}
            sandbox={sandbox}
          />
        ) : editorSchema ? (
          // Reset the marker: an item's `required` is a null-hole guard, not a fill-me requirement (see RequiredFieldProvider).
          <RequiredFieldProvider required={false} invalid={false}>
            {renderField({
              schema: editorSchema,
              value: item,
              onChange: (val) => updateItem(index, val),
              path: `${path}.${index}`,
              // An array item is never optional; clearing would leave a null hole.
              required: true,
              // A mustache `title` is an item-label template, not a display label — use the resolved item label.
              label:
                editorSchema.title && !editorSchema.title.includes("{{")
                  ? editorSchema.title
                  : itemLabel(item, index),
              breadcrumbPath: innerPath,
              onBreadcrumbChange: (nextPath) => {
                onBreadcrumbChange?.([...itemPrefix(), ...nextPath]);
              },
              meta,
              decofile,
              onSaveReferencedBlock,
              previewBaseUrl,
              onAddSectionItem,
              onRequestAddSection,
              sandbox,
            })}
          </RequiredFieldProvider>
        ) : null}
      </div>
    );
  };

  if (selectedIndex !== null && selectedIndex < items.length) {
    const item = arrayItemDisplayValue(items[selectedIndex], v8);
    /**
     * Trail prefix through the open item's own crumb — the base that nested
     * fields prepend their breadcrumb changes onto.
     *
     * Locate that crumb by INDEX (`selection.crumbIndex`), never by a label
     * lookup: a churning or duplicate label matches the wrong crumb — a
     * colliding sibling, or a same-labelled nested crumb — and strands the
     * prefix, snapping the editor back to the item the open one was duplicated
     * from. Refresh its label from `openItemLabelRef` (the fresh value stashed
     * by `updateItem` this same edit, before the new value re-renders here) so
     * the crumb tracks the item instead of freezing at its drill-in label.
     */
    const arrayItemPrefix = () => {
      if (!selection) {
        return buildArrayDrillDownBreadcrumb(
          breadcrumbPath,
          label,
          itemLabel(item, selectedIndex),
          selectedIndex,
          drillDownOpts,
        );
      }
      const prefix = breadcrumbPath.slice(0, selection.crumbIndex + 1);
      const stashed = openItemLabelRef.current;
      const freshLabel =
        stashed?.path === path && stashed.index === selectedIndex
          ? stashed.label
          : itemLabel(item, selectedIndex);
      prefix[selection.crumbIndex] = withItemCrumbLabel(
        prefix[selection.crumbIndex],
        freshLabel,
        selectedIndex,
      );
      return prefix;
    };

    return renderItemEditor(
      selectedIndex,
      selection?.innerPath ?? [],
      arrayItemPrefix,
    );
  }

  if (isNonArrayStoredValue(value)) {
    return (
      <div className="space-y-2">
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("sectionsEditor.arrayField.nonArrayValue")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <FieldDescriptionTooltip
          description={schema.description}
          virtualMcpId={sandbox?.virtualMcpId}
        >
          <span className="min-w-0 truncate text-sm font-medium">
            {label}
            {requiredProp && requiredInvalid && (
              <MissingRequiredMarker className="ml-1 inline-block align-middle" />
            )}
          </span>
        </FieldDescriptionTooltip>
        {items.length > 0 && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {items.length}
          </span>
        )}
        {canEditInline && items.length > 0 && (
          <ViewModeToggle<ArrayFieldLayout>
            className="ml-auto shrink-0"
            value={layoutPreference}
            onValueChange={setLayoutPreference}
            options={[
              {
                value: "drill",
                icon: <List />,
                tooltip: t("sectionsEditor.arrayField.layoutDrill"),
              },
              {
                value: "inline",
                icon: <Rows01 />,
                tooltip: t("sectionsEditor.arrayField.layoutInline"),
              },
            ]}
          />
        )}
      </div>

      {!tooltipsEnabled && schema.description && (
        <p className="break-words text-xs leading-normal text-muted-foreground">
          {schema.description}
        </p>
      )}

      {(items.length > 0 || compact) && (
        <div className={cn(activeEntryId && "cursor-grabbing")}>
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
              <div className="min-w-0 overflow-hidden rounded-[var(--studio-surface-radius,var(--radius-xl))] border card-shadow border-border/50 p-1.5">
                {items.length > 0 &&
                  (() => {
                    // Compute base labels once for the whole list rather than per
                    // row. Display only — the row opens its item by `entry.index`,
                    // not by label — so colliding rows share a clean label (no
                    // positional " N" suffix); the breadcrumb addresses items by
                    // the index its crumb carries.
                    const itemLabels = getArrayItemDisplayLabels(
                      items,
                      itemSchema,
                    );
                    return entries.map((entry) => {
                      const item = items[entry.index];
                      if (item === undefined) return null;
                      const labelText =
                        itemLabels[entry.index] ?? itemLabel(item, entry.index);
                      const displayValue = arrayItemDisplayValue(item, v8);
                      const imageSrc = getArrayItemImageSrc(
                        displayValue,
                        itemSchema,
                      );
                      const missingRequired = hasMissingRequiredField(
                        itemEditorSchema(
                          displayValue,
                          itemSchema,
                          meta,
                          containerResolveType,
                          arrayFieldKey,
                        ),
                        displayValue,
                      );
                      return (
                        <SortableArrayRow
                          key={entry.id}
                          sortableId={entry.id}
                          labelText={labelText}
                          imageSrc={imageSrc}
                          missingRequired={missingRequired}
                          hidden={isArrayItemHidden(item, v8)}
                          onToggleHidden={
                            canHideItems
                              ? () => toggleItemHidden(entry.index)
                              : undefined
                          }
                          expanded={
                            inline ? expandedEntryIds.has(entry.id) : undefined
                          }
                          onOpen={() =>
                            inline
                              ? toggleEntryExpanded(entry.id)
                              : openItem(entry.index)
                          }
                          onDuplicate={() => duplicateItem(entry.index)}
                          onRemove={() => removeItem(entry.index)}
                        >
                          {inline &&
                            expandedEntryIds.has(entry.id) &&
                            renderItemEditor(entry.index, [], () =>
                              buildArrayDrillDownBreadcrumb(
                                breadcrumbPath,
                                label,
                                itemLabel(item, entry.index),
                                entry.index,
                                drillDownOpts,
                              ),
                            )}
                        </SortableArrayRow>
                      );
                    });
                  })()}
                {compact && (
                  <AddListRow
                    iconHeightClassName={
                      hasThumbnails ? ARRAY_ROW_THUMBNAIL_HEIGHT : undefined
                    }
                    label={
                      usesSectionPicker
                        ? t("sectionsEditor.arrayField.addSection")
                        : t("sectionsEditor.arrayField.addItem")
                    }
                    onAdd={handleAddClick}
                  />
                )}
              </div>
            </SortableContext>

            {/* Portal to body so the overlay's `position: fixed` resolves
                against the viewport, not the workspace Panel's
                `transform: translateZ(0)` containing block (which would drop
                the dragged row below the cursor). */}
            {createPortal(
              <DragOverlay dropAnimation={SORTABLE_DROP_ANIMATION}>
                {activeLabel ? (
                  <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-background px-2 py-2.5 shadow-lg ring-1 ring-border/60">
                    <ArrayRowContent
                      labelText={activeLabel}
                      imageSrc={activeImage}
                    />
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        </div>
      )}

      {!compact && (
        <button
          type="button"
          onClick={handleAddClick}
          className="flex w-full items-center justify-center gap-1.5 rounded-[var(--studio-surface-radius,var(--radius-xl))] border border-dashed border-border/60 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus size={14} />
          {usesSectionPicker
            ? t("sectionsEditor.arrayField.addSection")
            : t("sectionsEditor.arrayField.addItem")}
        </button>
      )}
    </div>
  );
}
