import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useProductListPreview } from "../use-product-list-preview";
import {
  readProductListIds,
  writeProductListIds,
} from "./product-loader-utils";
import type { ResolvedProductPreview } from "./product-preview-utils";
import { AddButton, RemoveButton, str } from "./primitives";

function ProductThumbnail({
  preview,
  loading,
}: {
  preview: ResolvedProductPreview | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="h-12 w-12 shrink-0 animate-pulse rounded-md bg-muted" />
    );
  }

  if (preview?.imageUrl) {
    return (
      <img
        src={preview.imageUrl}
        alt={preview.name}
        className="h-12 w-12 shrink-0 rounded-md border object-cover"
      />
    );
  }

  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] text-muted-foreground">
      No img
    </div>
  );
}

function ProductIdsEditor({
  loader,
  ids,
  onChange,
  label,
}: {
  loader: unknown;
  ids: string[];
  onChange: (ids: string[]) => void;
  label: string;
}) {
  const { productsById, isLoading, isError } = useProductListPreview(loader);
  const setAt = (index: number, value: string) =>
    onChange(ids.map((id, i) => (i === index ? value : id)));

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {isError && (
        <p className="text-xs text-destructive">
          Could not load product details from VTEX.
        </p>
      )}
      {ids.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No product IDs yet — add one below.
        </p>
      )}
      <ul className="space-y-2">
        {ids.map((id, index) => {
          const preview = productsById[index] ?? null;
          return (
            <li key={index} className="group/item flex items-center gap-3">
              <ProductThumbnail preview={preview} loading={isLoading && !!id} />
              <div className="min-w-0 flex-1 space-y-1">
                <p
                  className={cn(
                    "truncate text-sm font-medium",
                    preview?.name ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {preview?.name ||
                    (isLoading && id ? "Loading product…" : "Product")}
                </p>
                <input
                  value={id}
                  onChange={(e) => setAt(index, e.target.value)}
                  placeholder="151331"
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
                />
              </div>
              <RemoveButton
                label="Remove product ID"
                onClick={() => onChange(ids.filter((_, i) => i !== index))}
              />
            </li>
          );
        })}
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
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const ids = readProductListIds(block.product);
  const productId = ids[0] ?? "";
  const { productsById, isLoading, isError } = useProductListPreview(
    block.product,
  );
  const preview = productsById[0] ?? null;

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Product card
      </div>
      <div className="flex items-center gap-3 rounded-md border bg-background p-3">
        <ProductThumbnail
          preview={preview}
          loading={isLoading && !!productId}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {preview?.name ||
              (isLoading && productId ? "Loading product…" : "Product preview")}
          </p>
          {productId && (
            <p className="truncate text-xs text-muted-foreground">
              ID {productId}
            </p>
          )}
          {isError && (
            <p className="text-xs text-destructive">
              Could not load product details from VTEX.
            </p>
          )}
        </div>
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
        <Label
          htmlFor="product-card-id"
          className="text-xs text-muted-foreground"
        >
          VTEX product ID
        </Label>
        <input
          id="product-card-id"
          value={productId}
          onChange={(e) =>
            onChange({
              ...block,
              product: writeProductListIds(
                block.product,
                e.target.value ? [e.target.value] : [],
              ),
            })
          }
          placeholder="151331"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
    </div>
  );
}

export function ProductShelfBlock({
  block,
  onChange,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const ids = readProductListIds(block.products);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <input
        value={str(block.title)}
        onChange={(e) => onChange({ ...block, title: e.target.value })}
        placeholder="Shelf title"
        className="w-full border-0 bg-transparent p-0 text-lg font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
      <ProductIdsEditor
        loader={block.products}
        label="VTEX product IDs"
        ids={ids}
        onChange={(nextIds) =>
          onChange({
            ...block,
            products: writeProductListIds(block.products, nextIds),
          })
        }
      />
    </div>
  );
}
