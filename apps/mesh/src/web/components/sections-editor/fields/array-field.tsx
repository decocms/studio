import { useRef, useState } from "react";
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
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsGrid, DotsHorizontal, Plus, Trash01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { getArrayItemImageSrc, getArrayItemLabel } from "../array-item-display";
import { isEmbeddedUnionResolveType } from "../block-type-utils";
import { resolveArrayItemSelection } from "../schema-form-breadcrumb";
import type { FieldProps } from "./field-props";
import { SchemaForm, renderField } from "../schema-form";

/** Stable DnD id per row; item data always comes from the `items` prop. */
interface ArrayEntry {
  id: string;
  index: number;
}

function createArrayEntries(count: number): ArrayEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    index,
  }));
}

function remapEntryIndices(entries: ArrayEntry[]): ArrayEntry[] {
  return entries.map((entry, index) => ({ ...entry, index }));
}

function resizeArrayEntries(
  current: ArrayEntry[],
  nextCount: number,
): ArrayEntry[] {
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

function ArrayRowContent({
  labelText,
  imageSrc,
}: {
  labelText: string;
  imageSrc?: string;
}) {
  return (
    <>
      <DotsGrid className="size-3.5 shrink-0 text-muted-foreground/40" />
      <div className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
        {imageSrc && (
          <img
            src={imageSrc}
            alt=""
            referrerPolicy="no-referrer"
            className="h-12 max-w-[100px] shrink-0 rounded object-cover"
          />
        )}
        <span className="min-w-0 truncate">{labelText}</span>
      </div>
    </>
  );
}

function SortableArrayRow({
  sortableId,
  labelText,
  imageSrc,
  onOpen,
  onRemove,
}: {
  sortableId: string;
  labelText: string;
  imageSrc?: string;
  onOpen: () => void;
  onRemove: () => void;
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-accent hover:text-accent-foreground touch-none",
        isDragging ? "cursor-grabbing" : "cursor-pointer",
      )}
      title={labelText}
    >
      <DotsGrid className="size-3.5 shrink-0 text-muted-foreground/40" />
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="h-12 max-w-[100px] shrink-0 rounded object-cover"
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{labelText}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Open actions for ${labelText}`}
            className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DotsHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onRemove}
          >
            <Trash01 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ArrayField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath = [],
  onBreadcrumbChange,
  meta,
  decofile,
  onSaveReferencedBlock,
}: FieldProps) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items;
  const selection = resolveArrayItemSelection(
    label,
    breadcrumbPath,
    items,
    itemSchema,
  );
  const selectedIndex = selection?.index ?? null;

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
  } else if (prevItemCount !== items.length) {
    setPrevItemCount(items.length);
    setEntries((current) => resizeArrayEntries(current, items.length));
  }

  const itemLabel = (item: unknown, index: number) =>
    getArrayItemLabel(item, index, itemSchema);

  const openItem = (index: number) => {
    if (suppressClickRef.current) return;
    const labelText = itemLabel(items[index], index);
    onBreadcrumbChange?.([...breadcrumbPath, labelText]);
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
    const labelText = getArrayItemLabel(defaultVal, nextIndex, itemSchema);
    onBreadcrumbChange?.([...breadcrumbPath, labelText]);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    if (selectedIndex === index) {
      const itemName = itemLabel(items[index], index);
      const itemIndex = breadcrumbPath.indexOf(itemName);
      onBreadcrumbChange?.(
        itemIndex >= 0 ? breadcrumbPath.slice(0, itemIndex) : [],
      );
    }
  };

  const updateItem = (index: number, val: unknown) => {
    const next = [...items];
    next[index] = val;
    onChange(next);
    if (selectedIndex === index) {
      const previousName = itemLabel(items[index], index);
      const labelText = itemLabel(val, index);
      const itemIndex = breadcrumbPath.indexOf(previousName);
      if (itemIndex >= 0) {
        const nextPath = [...breadcrumbPath];
        nextPath[itemIndex] = labelText;
        onBreadcrumbChange?.(nextPath);
        return;
      }
      onBreadcrumbChange?.([...breadcrumbPath, labelText]);
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
  const activeLabel =
    activeEntry != null && activeItem !== undefined
      ? itemLabel(activeItem, activeEntry.index)
      : null;
  const activeImage =
    activeEntry != null && activeItem !== undefined
      ? getArrayItemImageSrc(activeItem, itemSchema)
      : undefined;

  if (selectedIndex !== null && selectedIndex < items.length) {
    const item = items[selectedIndex];
    const arrayItemPrefix = () => {
      const itemName = itemLabel(item, selectedIndex);
      const itemIndex = breadcrumbPath.indexOf(itemName);
      if (itemIndex >= 0) {
        return breadcrumbPath.slice(0, itemIndex + 1);
      }
      return [...breadcrumbPath, itemName];
    };

    return (
      <div className="min-w-0">
        {itemSchema?.type === "object" && itemSchema.properties ? (
          <SchemaForm
            schema={itemSchema}
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
          />
        ) : itemSchema ? (
          renderField({
            schema: itemSchema,
            value: item,
            onChange: (val) => updateItem(selectedIndex, val),
            path: `${path}.${selectedIndex}`,
            label: itemSchema.title ?? `Item ${selectedIndex + 1}`,
            breadcrumbPath: selection?.innerPath ?? [],
            onBreadcrumbChange: (nextPath) => {
              onBreadcrumbChange?.([...arrayItemPrefix(), ...nextPath]);
            },
            meta,
            decofile,
            onSaveReferencedBlock,
          })
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{label}</span>
          {items.length > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {items.length}
            </span>
          )}
        </div>
        {schema.description && (
          <p className="break-words text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>

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
                {entries.map((entry) => {
                  const item = items[entry.index];
                  if (item === undefined) return null;
                  const labelText = itemLabel(item, entry.index);
                  const imageSrc = getArrayItemImageSrc(item, itemSchema);
                  return (
                    <SortableArrayRow
                      key={entry.id}
                      sortableId={entry.id}
                      labelText={labelText}
                      imageSrc={imageSrc}
                      onOpen={() => openItem(entry.index)}
                      onRemove={() => removeItem(entry.index)}
                    />
                  );
                })}
              </div>
            </SortableContext>

            <DragOverlay dropAnimation={null}>
              {activeLabel ? (
                <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-background px-2 py-2.5 shadow-lg ring-1 ring-border/60">
                  <ArrayRowContent
                    labelText={activeLabel}
                    imageSrc={activeImage}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      <button
        type="button"
        onClick={addItem}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/30"
      >
        <Plus size={14} />
        Add item
      </button>
    </div>
  );
}
