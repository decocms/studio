import { useState } from "react";
import {
  DotsGrid,
  Image01,
  Package,
  SearchSm,
  XClose,
} from "@untitledui/icons";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Label } from "@deco/ui/components/label.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import type { RunBlockSandboxRef } from "@/components/sandbox/content/use-run-block";
import {
  readProductListIds,
  writeProductListIds,
} from "./product-loader-utils";
import { ProductPickerDialog } from "./product-picker-dialog";
import { type ProductLookup, useProductsByIds } from "./use-product-lookup";
import type { ProductPickerOption } from "./product-picker-source";
import {
  formatHeadingValue,
  type HeadingLevel,
  HEADING_LEVELS,
  parseHeadingValue,
} from "./heading-value";
import { AddButton, RemoveButton, str, ToolbarButton } from "./primitives";

const HEADING_LEVEL_KEYS: Record<HeadingLevel, TranslationKey> = {
  normal: "sandbox.productBlocks.headingNormal",
  h1: "sandbox.productBlocks.headingH1",
  h2: "sandbox.productBlocks.headingH2",
  h3: "sandbox.productBlocks.headingH3",
};

/** Visual preview of the chosen level for the title input. */
const HEADING_LEVEL_CLASS: Record<HeadingLevel, string> = {
  normal: "text-lg font-semibold",
  h1: "text-3xl font-bold",
  h2: "text-2xl font-bold",
  h3: "text-xl font-semibold",
};

/** Title editor with a Normal/H1/H2/H3 selector that wraps the stored string. */
function ShelfTitle({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const { level, text } = parseHeadingValue(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-0.5">
        {HEADING_LEVELS.map((l) => (
          <ToolbarButton
            key={l}
            active={level === l}
            label={t(HEADING_LEVEL_KEYS[l])}
            onClick={() => onChange(formatHeadingValue(l, text))}
          >
            {t(HEADING_LEVEL_KEYS[l])}
          </ToolbarButton>
        ))}
      </div>
      <input
        value={text}
        onChange={(e) => onChange(formatHeadingValue(level, e.target.value))}
        placeholder={t("sandbox.productBlocks.shelfTitlePlaceholder")}
        className={cn(
          "w-full border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground/50 focus:ring-0",
          HEADING_LEVEL_CLASS[level],
        )}
      />
    </div>
  );
}

/** "Browse products" trigger — only shown when a running sandbox is available. */
function BrowseButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
    >
      <SearchSm size={13} />
      {label}
    </button>
  );
}

/** A framed product thumbnail (image, spinner while resolving, or a fallback). */
function ProductThumb({
  option,
  loading,
  className,
  iconSize = 18,
}: {
  option?: ProductPickerOption;
  loading: boolean;
  className?: string;
  iconSize?: number;
}) {
  return (
    <span
      className={cn(
        "flex items-center justify-center overflow-hidden bg-muted text-muted-foreground",
        className,
      )}
    >
      {option?.image ? (
        <img
          src={option.image}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain p-1.5"
        />
      ) : loading ? (
        <Spinner size="xs" />
      ) : (
        <Image01 size={iconSize} />
      )}
    </span>
  );
}

/** A product tile in the shelf grid — drag to reorder, hover to remove. */
function SortableProductCard({
  id,
  option,
  loading,
  onRemove,
}: {
  id: string;
  option?: ProductPickerOption;
  loading: boolean;
  onRemove: () => void;
}) {
  const t = useT();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group/card relative flex flex-col overflow-hidden rounded-md border bg-background",
        isDragging && "z-10 opacity-60",
      )}
    >
      <div className="relative aspect-square">
        <ProductThumb
          option={option}
          loading={loading}
          className="h-full w-full"
        />
        <button
          type="button"
          aria-label={t("sandbox.productBlocks.dragToReorderLabel")}
          {...attributes}
          {...listeners}
          className="absolute left-1 top-1 flex h-6 w-6 cursor-grab items-center justify-center rounded bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground active:cursor-grabbing group-hover/card:opacity-100"
        >
          <DotsGrid size={13} />
        </button>
        <button
          type="button"
          aria-label={t("sandbox.productBlocks.removeProductLabel")}
          onClick={onRemove}
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-destructive group-hover/card:opacity-100 cursor-pointer"
        >
          <XClose size={13} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <p className="line-clamp-2 text-xs leading-tight text-foreground">
          {option?.label ??
            (loading
              ? t("sandbox.productBlocks.loadingEllipsis")
              : t("sandbox.productBlocks.productWithId", { id }))}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {t("sandbox.productBlocks.idLabel", { id })}
        </p>
      </div>
    </div>
  );
}

/** The shelf's product grid with drag-to-reorder. */
function ProductGrid({
  ids,
  lookup,
  onReorder,
  onRemove,
}: {
  ids: string[];
  lookup: ProductLookup;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ids.map((id) => (
            <SortableProductCard
              key={id}
              id={id}
              option={lookup.byId.get(id)}
              loading={lookup.isLoading && !lookup.byId.get(id)}
              onRemove={() => onRemove(id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** Full-width dashed CTA shown when a shelf has no products yet. */
function EmptyProducts({ onBrowse }: { onBrowse: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onBrowse}
      className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed py-8 text-center transition-colors hover:border-foreground/30 hover:bg-muted/40 cursor-pointer"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Package size={16} />
      </span>
      <span className="text-sm font-medium text-foreground">
        {t("sandbox.productBlocks.addProductsButton")}
      </span>
      <span className="text-xs text-muted-foreground">
        {t("sandbox.productBlocks.addProductsDescription")}
      </span>
    </button>
  );
}

/** Manual SKU-id entry — fallback when no running sandbox can resolve products. */
function ProductIdsEditor({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const setAt = (index: number, value: string) =>
    onChange(ids.map((id, i) => (i === index ? value : id)));

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">
        {t("sandbox.productBlocks.vtexProductIds")}
      </Label>
      {ids.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("sandbox.productBlocks.startDevServerDescription")}
        </p>
      )}
      <ul className="space-y-2">
        {ids.map((id, index) => (
          <li key={index} className="group/item flex items-center gap-3">
            <input
              value={id}
              onChange={(e) => setAt(index, e.target.value)}
              placeholder={t("sandbox.productBlocks.skuIdPlaceholder")}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
            />
            <RemoveButton
              label={t("sandbox.productBlocks.removeProductIdButton")}
              onClick={() => onChange(ids.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <AddButton
        label={t("sandbox.productBlocks.addProductIdButton")}
        onClick={() => onChange([...ids, ""])}
      />
    </div>
  );
}

export function ProductShelfBlock({
  block,
  onChange,
  sandboxRef,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  sandboxRef?: RunBlockSandboxRef | null;
}) {
  const t = useT();
  const rawIds = readProductListIds(block.products);
  const ids = [...new Set(rawIds.filter(Boolean))];
  const [pickerOpen, setPickerOpen] = useState(false);
  const lookup = useProductsByIds(sandboxRef, ids);

  const setIds = (nextIds: string[]) =>
    onChange({
      ...block,
      products: writeProductListIds(block.products, nextIds),
    });

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <ShelfTitle
        value={str(block.title)}
        onChange={(title) => onChange({ ...block, title })}
      />

      {sandboxRef ? (
        <div className="space-y-3">
          {ids.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {ids.length}{" "}
                {t(
                  ids.length === 1
                    ? "sandbox.productBlocks.productSingular"
                    : "sandbox.productBlocks.productPlural",
                )}
              </span>
              <BrowseButton
                label={t("sandbox.productBlocks.browseProductsButton")}
                onClick={() => setPickerOpen(true)}
              />
            </div>
          )}
          {ids.length === 0 ? (
            <EmptyProducts onBrowse={() => setPickerOpen(true)} />
          ) : (
            <ProductGrid
              ids={ids}
              lookup={lookup}
              onReorder={setIds}
              onRemove={(id) => setIds(ids.filter((x) => x !== id))}
            />
          )}
        </div>
      ) : (
        <ProductIdsEditor ids={rawIds} onChange={setIds} />
      )}

      {sandboxRef && (
        <ProductPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          sandboxRef={sandboxRef}
          selectedIds={ids}
          onChange={setIds}
        />
      )}
    </div>
  );
}

/** Compact selected-product row for the ProductCard block. */
function SelectedProductRow({
  id,
  option,
  loading,
  onRemove,
}: {
  id: string;
  option?: ProductPickerOption;
  loading: boolean;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="group/item flex items-center gap-3 rounded-md border bg-background p-2">
      <ProductThumb
        option={option}
        loading={loading}
        className="h-11 w-11 shrink-0 rounded"
        iconSize={16}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          {option?.label ??
            (loading
              ? t("sandbox.productBlocks.loadingEllipsis")
              : t("sandbox.productBlocks.productWithId", { id }))}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.productBlocks.idLabel", { id })}
        </p>
      </div>
      <RemoveButton
        label={t("sandbox.productBlocks.removeProductButton")}
        onClick={onRemove}
      />
    </div>
  );
}

export function ProductCardBlock({
  block,
  onChange,
  sandboxRef,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  sandboxRef?: RunBlockSandboxRef | null;
}) {
  const t = useT();
  const productId = readProductListIds(block.product).filter(Boolean)[0] ?? "";
  const [pickerOpen, setPickerOpen] = useState(false);
  const lookup = useProductsByIds(sandboxRef, productId ? [productId] : []);

  const setIds = (nextIds: string[]) =>
    onChange({
      ...block,
      product: writeProductListIds(block.product, nextIds),
    });

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("sandbox.productBlocks.productCardLabel")}
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="product-card-cta"
          className="text-xs text-muted-foreground"
        >
          {t("sandbox.productBlocks.ctaLabelField")}
        </Label>
        <input
          id="product-card-cta"
          value={str(block.textCta)}
          onChange={(e) => onChange({ ...block, textCta: e.target.value })}
          placeholder={t("sandbox.productBlocks.ctaLabelPlaceholder")}
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="product-card-slug"
          className="text-xs text-muted-foreground"
        >
          {t("sandbox.productBlocks.productSlugField")}
        </Label>
        <input
          id="product-card-slug"
          value={str(block.productSlug)}
          onChange={(e) => onChange({ ...block, productSlug: e.target.value })}
          placeholder={t("sandbox.productBlocks.productSlugPlaceholder")}
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-muted-foreground">
            {t("sandbox.productBlocks.productField")}
          </Label>
          {sandboxRef && productId && (
            <BrowseButton
              label={t("sandbox.productBlocks.changeButton")}
              onClick={() => setPickerOpen(true)}
            />
          )}
        </div>
        {sandboxRef ? (
          productId ? (
            <SelectedProductRow
              id={productId}
              option={lookup.byId.get(productId)}
              loading={lookup.isLoading}
              onRemove={() => setIds([])}
            />
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
            >
              <SearchSm size={14} />
              {t("sandbox.productBlocks.chooseProductButton")}
            </button>
          )
        ) : (
          <input
            value={productId}
            onChange={(e) => setIds(e.target.value ? [e.target.value] : [])}
            placeholder={t("sandbox.productBlocks.vtexProductIdPlaceholder")}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
          />
        )}
      </div>

      {sandboxRef && (
        <ProductPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          sandboxRef={sandboxRef}
          selectedIds={productId ? [productId] : []}
          onChange={setIds}
          multiple={false}
        />
      )}
    </div>
  );
}
