# Deco Blocks Framework — AI Context Document

**Audience:** Claude (AI assistant). This document is injected into Claude's context to provide the full mental model of the deco blocks framework. Read it as a specification, not a tutorial.

---

## 1. What Deco Blocks Are (Mental Model)

A **block** is any configurable, composable unit in a deco site. "Block" is the generic name for the concept. Sections and loaders are the two concrete kinds of blocks in deco.

Every block is a TypeScript module with:
- A **default export** — the block's implementation (a function, component, or async function)
- An optional **`Props` interface** — the block's configurable surface (what the editor user can set)

The Props type is the contract between the block and the deco editor. The editor reads this type at runtime and renders a form. The user fills in values. Those values are passed to the block at render/execution time. No props interface means no configurable inputs — the block has a fixed behavior.

This type-driven approach means the **TypeScript type is the source of truth** for the editor UI. There is no separate schema registration or decorator — the type is the schema.

---

## 2. Sections

Sections are the UI rendering units of deco. Think of them as rows or components on a page.

**Where they live:** `sections/` folder in the project root.

**File structure:**
```typescript
// sections/ProductShelf.tsx
export interface Props {
  title: string;
  /** @description Number of products to display */
  count?: number;
  showPrices?: boolean;
}

export default function ProductShelf({ title, count = 10, showPrices = true }: Props) {
  return (
    <div>
      <h2>{title}</h2>
      {/* render products */}
    </div>
  );
}
```

**Key rules for sections:**
- Default export is a function or React component that receives `Props`
- The function is synchronous — data fetching is handled by loaders, not sections
- Props can include: strings, numbers, booleans, arrays, nested objects, and deco-specific primitives (ImageWidget, RichText, Video)
- Optional props should have default values; required props without defaults will be marked required in the editor form
- The section filename (without extension) becomes the block name: `ProductShelf.tsx` → block named `ProductShelf`

---

## 3. Loaders

Loaders are the data-fetching units. They run on the server before render and pass their output as props to sections.

**Where they live:** `loaders/` folder in the project root.

**File structure:**
```typescript
// loaders/products.ts
export interface Props {
  /** @description Product category slug */
  category: string;
  limit?: number;
}

const loader = async (
  props: Props,      // Configurable — shown in editor
  _req: Request,     // Runtime context — NOT shown in editor
  ctx: AppContext,   // Runtime context — NOT shown in editor
): Promise<Product[] | null> => {
  const { category, limit = 20 } = props;
  return ctx.invoke("shopify.loaders/productList", { category, limit });
};

export default loader;
```

**Key rules for loaders:**
- Default export is an `async` function
- Signature is always: `(props: Props, req: Request, ctx: AppContext) => Promise<ReturnType>`
- Only the first parameter (`props`) is configurable — it is what the editor exposes to the user
- Second (`req`) and third (`ctx`) parameters are runtime context — they are NEVER shown in the editor form
- The return type must be explicit — it determines which sections can accept this loader's output
- The loader filename becomes the block name: `products.ts` → loader named `products`

---

## 4. How Blocks Compose Into Pages

A deco page is an ordered list of sections stored as JSON (in `.deco/` or a CMS). Each entry in the list contains:
1. **Which section file** to use (e.g., `sections/ProductShelf.tsx`)
2. **Saved prop values** for the configurable props (e.g., `{ title: "Featured", count: 6 }`)
3. **Loader bindings** for props that come from loaders instead of direct user input

Loader binding works by **type matching**: if a section has a prop typed as `Product[]`, deco can connect a loader that returns `Product[]` to fill that prop. The binding is stored as a reference — "prop `products` on this section is wired to loader `shopify/productList` with these loader props."

At render time, deco:
1. Resolves all loader bindings in parallel
2. Merges loader outputs with direct prop values
3. Renders sections in order, passing the merged props to each section

This architecture means sections are **pure rendering functions** — they never fetch data. Loaders are **pure data functions** — they never render. The wiring is declarative and stored in the page JSON.

---

## 5. The `.deco/` Folder and Block Registration

The `.deco/` folder contains site configuration: available blocks, page data, and global state (e.g., theme, feature flags).

**Block auto-discovery:** There is no explicit registration step. A block is available to the site if:
- It is in the `sections/` or `loaders/` folder (or a subfolder)
- It has an `export default` declaration

Deco's runtime scans these folders at startup and discovers all blocks automatically. Adding a new file with a default export immediately makes it available in the editor. Removing or renaming a file removes it.

**Page data:** Pages are stored as JSON in `.deco/pages/` or synced to a CMS. The JSON references section files by path and stores prop values. This JSON is what the editor reads and writes.

---

## 6. Props Design Philosophy

Props are the **configurable surface** of a block — only what a content editor or site owner needs to customize. They are not the block's full API.

**What belongs in props:**
- User-visible content (titles, descriptions, images, CTA text)
- Layout options (number of items, show/hide toggles, color variants)
- Data query parameters that editors configure (category slug, product IDs)

**What does NOT belong in props:**
- API keys, auth tokens, secrets — these go in `ctx` (AppContext)
- Runtime fetch parameters that are always constant — hardcode in the loader
- Internal implementation state — use component state or server-side logic

**JSDoc annotations become editor help text:**
```typescript
export interface Props {
  /** @title Hero Title */
  /** @description The main headline shown on the hero banner */
  title: string;

  /** @format color */
  backgroundColor?: string;
}
```
- `@title` overrides the field label in the editor (default: camelCase field name)
- `@description` adds help text below the field
- `@format` hints the editor widget type (e.g., `color`, `date`, `uri`)

**Optional vs required:**
- Required props (no `?`, no default) → editor marks them as required; saving fails if empty
- Optional props with defaults → default is shown in the editor as placeholder value
- Optional props without defaults → field is optional in the editor; the block must handle `undefined`

---

## 7. Key Mental Model Rules

These rules let Claude identify and work with deco blocks correctly:

| Situation | Rule |
|-----------|------|
| File in `sections/` with `export default` | It is a section block |
| File in `loaders/` with `export default` | It is a loader block |
| Any file with `export default` elsewhere | It is a generic block (kind: `'block'`) |
| First parameter's type on the default export | That is the Props interface — the editor form source of truth |
| Second and third parameters on a loader | Runtime context — not configurable, not shown in editor |
| `export default` absent in a file | Not a block, even if it is in `sections/` or `loaders/` |
| Named exports only | Not a block — deco requires `export default` |

**Corollary:** When writing or modifying blocks, the Props interface is the user-facing API. Everything else (imports, helper functions, API calls, ctx usage) is implementation detail that the editor never sees.

**Type matching for loader-to-section wiring:** A section prop of type `Product[]` can accept any loader that returns `Product[]`. This is checked structurally (TypeScript structural subtyping), not by name. If you want a loader's output to wire to a section prop, make their types match exactly.

---

## 8. Common Patterns Reference

### Minimal section (no props)
```typescript
export default function StaticBanner() {
  return <div>Always the same content</div>;
}
```

### Section with required and optional props
```typescript
export interface Props {
  title: string;          // required
  subtitle?: string;      // optional
  itemCount?: number;     // optional with default below
}

export default function HeroSection({ title, subtitle, itemCount = 5 }: Props) {
  // ...
}
```

### Loader that feeds a section
```typescript
// loaders/products.ts — returns Product[]
const loader = async (props: Props, _req: Request, ctx: AppContext): Promise<Product[]> => {
  return fetchProducts(props.category);
};
export default loader;

// sections/ProductShelf.tsx — accepts Product[]
export interface Props {
  products: Product[];  // wired from loader by type match
  title: string;        // direct user input
}
export default function ProductShelf({ products, title }: Props) {
  // ...
}
```

### Loader with explicit return type for wiring
Always annotate the return type explicitly. Deco uses the return type to suggest compatible sections in the editor. Without an explicit return type, deco cannot infer it at build time.

---

*This document is the primary AI context source for the deco blocks framework. When working with deco projects, load this document to understand the mental model before reading or writing block code.*
