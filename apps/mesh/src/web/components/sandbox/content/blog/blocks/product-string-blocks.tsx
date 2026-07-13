import { Label } from "@deco/ui/components/label.tsx";
import { DynamicOptionsField } from "@/web/components/sections-editor/fields/dynamic-options-field";
import type { SandboxConfig } from "@/web/components/sections-editor/fields/field-props";
import type { SchemaProperty } from "@/web/components/sections-editor/resolve-schema";
import { AddButton, RemoveButton, str } from "./primitives";
import { readStringRef, readStringRefList } from "./product-string-utils";

/**
 * Shared schema for the `platform:kind:id` product reference — drives the
 * same searchable, image-aware `DynamicOptionsField` picker the generic
 * `SchemaForm` renders for site-defined blog blocks (via `@format
 * dynamic-options` / `@options`), instead of a raw text input.
 */
const PRODUCT_REF_SCHEMA: SchemaProperty = {
  type: "string",
  format: "dynamic-options",
  options: "blog/loaders/options/productsByTerm.ts",
};

function ProductRefsEditor({
  refs,
  onChange,
  label,
  sandbox,
  basePath,
}: {
  refs: string[];
  onChange: (refs: string[]) => void;
  label: string;
  sandbox?: SandboxConfig | null;
  basePath: string;
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
            <div className="min-w-0 flex-1">
              <DynamicOptionsField
                schema={PRODUCT_REF_SCHEMA}
                value={ref}
                onChange={(next) => setAt(index, String(next ?? ""))}
                path={`${basePath}.${index}`}
                label=""
                sandbox={sandbox}
              />
            </div>
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
  sandbox,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  sandbox?: SandboxConfig | null;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Product card
      </div>
      <DynamicOptionsField
        schema={PRODUCT_REF_SCHEMA}
        value={readStringRef(block.product)}
        onChange={(next) => onChange({ ...block, product: String(next ?? "") })}
        path="app-product-card-ref"
        label="Product"
        sandbox={sandbox}
      />
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
  sandbox,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  sandbox?: SandboxConfig | null;
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
          })
        }
        sandbox={sandbox}
        basePath="app-product-shelf-refs"
      />
    </div>
  );
}
