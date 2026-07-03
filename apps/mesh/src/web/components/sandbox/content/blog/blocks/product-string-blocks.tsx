import { Label } from "@deco/ui/components/label.tsx";
import { AddButton, RemoveButton, str } from "./primitives";
import { readStringRef, readStringRefList } from "./product-string-utils";

const PRODUCT_REF_PLACEHOLDER = "vtex:product:123";

function ProductRefsEditor({
  refs,
  onChange,
  label,
}: {
  refs: string[];
  onChange: (refs: string[]) => void;
  label: string;
}) {
  const setAt = (index: number, value: string) =>
    onChange(refs.map((ref, i) => (i === index ? value : ref)));

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {refs.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No product references yet — add one below.
        </p>
      )}
      <ul className="space-y-2">
        {refs.map((ref, index) => (
          <li key={index} className="group/item flex items-center gap-3">
            <input
              value={ref}
              onChange={(e) => setAt(index, e.target.value)}
              placeholder={PRODUCT_REF_PLACEHOLDER}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
            />
            <RemoveButton
              label="Remove product reference"
              onClick={() => onChange(refs.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <AddButton
        label="Add product reference"
        onClick={() => onChange([...refs, ""])}
      />
    </div>
  );
}

/** Editor for deco-cms/blog app blocks — persists `platform:kind:id` strings. */
export function AppProductCardBlock({
  block,
  onChange,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Product card
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="app-product-card-ref"
          className="text-xs text-muted-foreground"
        >
          Product reference
        </Label>
        <input
          id="app-product-card-ref"
          value={readStringRef(block.product)}
          onChange={(e) =>
            onChange({
              ...block,
              product: e.target.value,
            })}
          placeholder={PRODUCT_REF_PLACEHOLDER}
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="app-product-card-cta"
          className="text-xs text-muted-foreground"
        >
          CTA label
        </Label>
        <input
          id="app-product-card-cta"
          value={str(block.cta)}
          onChange={(e) => onChange({ ...block, cta: e.target.value })}
          placeholder="Comprar"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
      <div className="space-y-2">
        <Label
          htmlFor="app-product-card-badge"
          className="text-xs text-muted-foreground"
        >
          Badge
        </Label>
        <input
          id="app-product-card-badge"
          value={str(block.badge)}
          onChange={(e) => onChange({ ...block, badge: e.target.value })}
          placeholder="New"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
    </div>
  );
}

/** Editor for deco-cms/blog ProductShelf — persists string[] references. */
export function AppProductShelfBlock({
  block,
  onChange,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const refs = readStringRefList(block.products);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <input
        value={str(block.title)}
        onChange={(e) => onChange({ ...block, title: e.target.value })}
        placeholder="Shelf title"
        className="w-full border-0 bg-transparent p-0 text-lg font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
      <ProductRefsEditor
        label="Product references"
        refs={refs}
        onChange={(nextRefs) =>
          onChange({
            ...block,
            products: nextRefs,
          })}
      />
    </div>
  );
}
