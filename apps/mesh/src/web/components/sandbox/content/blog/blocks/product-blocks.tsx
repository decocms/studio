import { useState } from "react";
import { SearchSm } from "@untitledui/icons";
import { Label } from "@deco/ui/components/label.tsx";
import type { RunBlockSandboxRef } from "@/web/components/sandbox/content/use-run-block";
import {
  readProductListIds,
  writeProductListIds,
} from "./product-loader-utils";
import { ProductPickerDialog } from "./product-picker-dialog";
import { AddButton, RemoveButton, str } from "./primitives";

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

function ProductIdsEditor({
  ids,
  onChange,
  label,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  label?: string;
}) {
  const setAt = (index: number, value: string) =>
    onChange(ids.map((id, i) => (i === index ? value : id)));

  return (
    <div className="space-y-2">
      {label && (
        <Label className="text-xs text-muted-foreground">{label}</Label>
      )}
      {ids.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No product IDs yet — add one below.
        </p>
      )}
      <ul className="space-y-2">
        {ids.map((id, index) => (
          <li key={index} className="group/item flex items-center gap-3">
            <input
              value={id}
              onChange={(e) => setAt(index, e.target.value)}
              placeholder="151331"
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
            />
            <RemoveButton
              label="Remove product ID"
              onClick={() => onChange(ids.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <AddButton
        label="Add product ID"
        onClick={() => onChange([...ids, ""])}
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
  const ids = readProductListIds(block.product);
  const productId = ids[0] ?? "";
  const [pickerOpen, setPickerOpen] = useState(false);

  const setIds = (nextIds: string[]) =>
    onChange({
      ...block,
      product: writeProductListIds(block.product, nextIds),
    });

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Product card
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="product-card-cta"
          className="text-xs text-muted-foreground"
        >
          CTA label
        </Label>
        <input
          id="product-card-cta"
          value={str(block.textCta)}
          onChange={(e) => onChange({ ...block, textCta: e.target.value })}
          placeholder="Ver produto"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="product-card-slug"
          className="text-xs text-muted-foreground"
        >
          Product slug
        </Label>
        <input
          id="product-card-slug"
          value={str(block.productSlug)}
          onChange={(e) => onChange({ ...block, productSlug: e.target.value })}
          placeholder="product-slug"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor="product-card-id"
            className="text-xs text-muted-foreground"
          >
            VTEX product ID
          </Label>
          {sandboxRef && (
            <BrowseButton label="Browse" onClick={() => setPickerOpen(true)} />
          )}
        </div>
        <input
          id="product-card-id"
          value={productId}
          onChange={(e) => setIds(e.target.value ? [e.target.value] : [])}
          placeholder="151331"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      {sandboxRef && (
        <ProductPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          sandboxRef={sandboxRef}
          selectedIds={ids.filter(Boolean)}
          onChange={setIds}
          multiple={false}
        />
      )}
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
  const ids = readProductListIds(block.products);
  const [pickerOpen, setPickerOpen] = useState(false);

  const setIds = (nextIds: string[]) =>
    onChange({
      ...block,
      products: writeProductListIds(block.products, nextIds),
    });

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <input
        value={str(block.title)}
        onChange={(e) => onChange({ ...block, title: e.target.value })}
        placeholder="Shelf title"
        className="w-full border-0 bg-transparent p-0 text-lg font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">
          VTEX product IDs
        </Label>
        {sandboxRef && (
          <BrowseButton
            label="Browse products"
            onClick={() => setPickerOpen(true)}
          />
        )}
      </div>
      <ProductIdsEditor ids={ids} onChange={setIds} />
      {sandboxRef && (
        <ProductPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          sandboxRef={sandboxRef}
          selectedIds={ids.filter(Boolean)}
          onChange={setIds}
        />
      )}
    </div>
  );
}
