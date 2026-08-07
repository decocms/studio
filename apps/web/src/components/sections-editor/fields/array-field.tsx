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
import { Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { SORTABLE_DROP_ANIMATION } from "@/lib/dnd-drop-animation.ts";
import { cn } from "@deco/ui/lib/utils.ts";
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
  buildArrayDrillDownBreadcrumb,
  findBreadcrumbLabelIndex,
  resolveArrayItemSelection,
} from "../schema-form-breadcrumb";
import { isSectionArrayField } from "../section-array-field";
import {
  type ArrayEntry,
  createArrayEntries,
  insertEntryAfter,
  remapEntryIndices,
  removeEntryAt,
  resizeArrayEntries,
} from "./array-entries";
import {
  FieldDescriptionTooltip,
  useFieldDescriptionTooltips,
} from "./field-label";
import type { FieldProps } from "./field-props";
import { ArrayRowContent, SortableArrayRow } from "./array-row";
import { SchemaForm, renderField } from "../schema-form";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "../resolve-schema";

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
  breadcrumbPath = [],
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
  const t = useT();
  const tooltipsEnabled = useFieldDescriptionTooltips(sandbox?.virtualMcpId);
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items;
  const arrayFieldKey = arrayFieldKeyFromPath(path);
  // Options that let buildArrayDrillDownBreadcrumb decide whether this array's
  // own label must stay in the trail to keep the item uniquely addressable.
  const drillDownOpts = {
    arrayKey: arrayFieldKey,
    hasSiblingDrillDownFields,
  };
  const usesSectionPicker = isSectionArrayField(schema, arrayFieldKey);
  // Only plain object arrays (banners, links, …) get the hide toggle. Section
  // pickers have their own hide flow, and primitive arrays can't be wrapped.
  const canHideItems = !usesSectionPicker && itemSchema?.type === "object";
  // Index of the item the user has explicitly opened. Array items are addressed
  // in the breadcrumb by their (mutable) display label; `getArrayItemLabels`
  // keeps those labels unique, but this preferred index still pins selection to
  // the opened row through the brief window where an edit makes labels churn
  // (e.g. typing a name/alt that momentarily matches a sibling before the
  // positional suffix settles).
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const selection = resolveArrayItemSelection(
    label,
    breadcrumbPath,
    items,
    itemSchema,
    openIndex,
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
  const [prevListKey, setPrevListKey] = useState(path);
  const [prevItemCount, setPrevItemCount] = useState(items.length);
  const suppressClickRef = useRef(false);

  if (prevListKey !== path) {
    setPrevListKey(path);
    setPrevItemCount(items.length);
    setEntries(createArrayEntries(items.length));
    setOpenIndex(null);
  } else if (prevItemCount !== items.length) {
    setPrevItemCount(items.length);
    setEntries((current) => resizeArrayEntries(current, items.length));
  }

  const itemLabel = (
    item: unknown,
    index: number,
    siblings: unknown[] = items,
  ) =>
    getArrayItemLabel(arrayItemDisplayValue(item), index, itemSchema, siblings);

  const openItem = (index: number) => {
    if (suppressClickRef.current) return;
    const labelText = itemLabel(items[index], index);
    setOpenIndex(index);
    onBreadcrumbChange?.(
      buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        labelText,
        drillDownOpts,
      ),
    );
  };

  const appendItem = (item: unknown) => {
    const next = [...items, item];
    onChange(next);
    const nextIndex = next.length - 1;
    setOpenIndex(nextIndex);
    const labelText = getArrayItemLabel(item, nextIndex, itemSchema, next);
    onBreadcrumbChange?.(
      buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        labelText,
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
    const nextIndex = next.length - 1;
    setOpenIndex(nextIndex);
    const labelText = getArrayItemLabel(
      defaultVal,
      nextIndex,
      itemSchema,
      next,
    );
    onBreadcrumbChange?.(
      buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        labelText,
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
    next[index] = isArrayItemHidden(item)
      ? showArrayItem(item)
      : hideArrayItem(item);
    onChange(next);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    setEntries((current) => removeEntryAt(current, index));
  };

  const updateItem = (index: number, val: unknown) => {
    const next = [...items];
    // Preserve the hidden wrapper when editing a hidden item's inner value.
    next[index] = isArrayItemHidden(items[index]) ? hideArrayItem(val) : val;
    onChange(next);

    // When editing the currently selected item, the display label may change
    // (e.g. editing the "alt" or "name" field that drives getArrayItemLabel).
    // Rewrite the item's crumb IN PLACE — at the position resolution matched it
    // (`selection.crumbIndex`), not by looking up its old text — so
    // resolveArrayItemSelection keeps pointing at THIS item. A text lookup
    // strands the crumb once the old label is gone: the edited item then
    // re-resolves to a colliding sibling, e.g. the "original" a duplicate was
    // copied from.
    if (index === selectedIndex && selection) {
      const oldLabel = itemLabel(items[index], index);
      const newLabel = itemLabel(next[index], index, next);
      if (oldLabel !== newLabel) {
        const updatedBreadcrumb = [...breadcrumbPath];
        updatedBreadcrumb[selection.crumbIndex] = newLabel;
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
      ? getArrayItemImageSrc(arrayItemDisplayValue(activeItem), itemSchema)
      : undefined;

  if (selectedIndex !== null && selectedIndex < items.length) {
    const item = arrayItemDisplayValue(items[selectedIndex]);
    const editorSchema = itemEditorSchema(
      item,
      itemSchema,
      meta,
      containerResolveType,
      arrayFieldKey,
    );
    const arrayItemPrefix = () => {
      const itemName = itemLabel(item, selectedIndex);
      const trail = buildArrayDrillDownBreadcrumb(
        breadcrumbPath,
        label,
        itemName,
        drillDownOpts,
      );
      const itemIndex = findBreadcrumbLabelIndex(trail, itemName);
      if (itemIndex >= 0) {
        return trail.slice(0, itemIndex + 1);
      }
      return trail;
    };

    return (
      <div className="min-w-0">
        {editorSchema?.type === "object" && editorSchema.properties ? (
          <SchemaForm
            schema={editorSchema}
            value={item}
            onChange={(val) => updateItem(selectedIndex, val)}
            basePath={`${path}.${selectedIndex}`}
            breadcrumbPath={selection?.innerPath ?? []}
            onBreadcrumbChange={(nextPath) => {
              onBreadcrumbChange?.([...arrayItemPrefix(), ...nextPath]);
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
          renderField({
            schema: editorSchema,
            value: item,
            onChange: (val) => updateItem(selectedIndex, val),
            path: `${path}.${selectedIndex}`,
            // A mustache `title` (e.g. "{{{city}}} {{{regionCode}}}") is an
            // item-label template, not a display label — use the resolved item
            // label so the header reads "SP BR" instead of the raw template.
            label:
              editorSchema.title && !editorSchema.title.includes("{{")
                ? editorSchema.title
                : itemLabel(item, selectedIndex),
            breadcrumbPath: selection?.innerPath ?? [],
            onBreadcrumbChange: (nextPath) => {
              onBreadcrumbChange?.([...arrayItemPrefix(), ...nextPath]);
            },
            meta,
            decofile,
            onSaveReferencedBlock,
            previewBaseUrl,
            onAddSectionItem,
            onRequestAddSection,
            sandbox,
          })
        ) : null}
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
          <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        </FieldDescriptionTooltip>
        {items.length > 0 && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {items.length}
          </span>
        )}
      </div>

      {!tooltipsEnabled && schema.description && (
        <p className="break-words text-xs leading-normal text-muted-foreground">
          {schema.description}
        </p>
      )}

      {items.length > 0 && (
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
              <div className="min-w-0 overflow-hidden rounded-xl border border-border/50 p-1.5">
                {(() => {
                  // Compute base labels once for the whole list rather than per
                  // row (each derivation scans all siblings). These are display
                  // only — the row opens its item by `entry.index`, not by label
                  // — so they stay un-disambiguated (no positional " N" suffix);
                  // the breadcrumb still addresses items by the unique label from
                  // getArrayItemLabels.
                  const itemLabels = getArrayItemDisplayLabels(
                    items,
                    itemSchema,
                  );
                  return entries.map((entry) => {
                    const item = items[entry.index];
                    if (item === undefined) return null;
                    const labelText =
                      itemLabels[entry.index] ?? itemLabel(item, entry.index);
                    const imageSrc = getArrayItemImageSrc(
                      arrayItemDisplayValue(item),
                      itemSchema,
                    );
                    return (
                      <SortableArrayRow
                        key={entry.id}
                        sortableId={entry.id}
                        labelText={labelText}
                        imageSrc={imageSrc}
                        hidden={isArrayItemHidden(item)}
                        onToggleHidden={
                          canHideItems
                            ? () => toggleItemHidden(entry.index)
                            : undefined
                        }
                        onOpen={() => openItem(entry.index)}
                        onDuplicate={() => duplicateItem(entry.index)}
                        onRemove={() => removeItem(entry.index)}
                      />
                    );
                  });
                })()}
              </div>
            </SortableContext>

            {/* Portal to body so the overlay's `position: fixed` resolves
                against the viewport, not the workspace PanelCard's
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

      <button
        type="button"
        onClick={handleAddClick}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/30"
      >
        <Plus size={14} />
        {usesSectionPicker
          ? t("sectionsEditor.arrayField.addSection")
          : t("sectionsEditor.arrayField.addItem")}
      </button>
    </div>
  );
}
