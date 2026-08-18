import { arrayItemDisplayValue } from "./array-item-hidden";
import { lazyWrappedInner } from "./block-ref-field-utils";
import { extractUrl } from "./fields/extract-url";
import { inferInlineUnionIndex } from "./fields/inline-union-value";
import type { SchemaProperty } from "./resolve-schema";
import { labelFromResolveType } from "./section-types";
import { safeEditorImageUrl } from "./safe-editor-image-url";

function resolveResolvable(obj: Record<string, unknown>): string | undefined {
  if (Array.isArray(obj.variants)) {
    const variants = obj.variants as Array<{
      rule?: { __resolveType?: string };
      value?: unknown;
    }>;
    const always = variants.find((v) =>
      v.rule?.__resolveType?.includes("always"),
    );
    if (typeof always?.value === "string") return always.value;
    const first = variants.find((v) => typeof v.value === "string");
    if (first) return first.value as string;
  }
  if (typeof obj.src === "string") return obj.src;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.value === "string") return obj.value;
  return undefined;
}

function resolveImageValue(value: unknown): unknown {
  if (typeof value === "string" || value == null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(resolveImageValue);
  }
  const obj = value as Record<string, unknown>;
  if (obj.__resolveType) {
    return resolveResolvable(obj) ?? value;
  }
  return resolveImageValues(obj);
}

function resolveImageValues(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = resolveImageValue(value);
  }
  return result;
}

function getByPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, data);
}

export function formatMustacheValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(formatMustacheValue).filter(Boolean).join(",");
  }
  if (typeof value === "object") return "";
  return String(value);
}

export function renderMustacheTemplate(
  template: string,
  data: Record<string, unknown>,
): string | undefined {
  if (!template.includes("{")) return undefined;
  const resolved = resolveImageValues(data);
  const result = template.replace(
    /\{\{\{([^}]+)\}\}\}|\{\{([^}]+)\}\}/g,
    (_match, tripleKey: string | undefined, doubleKey: string | undefined) => {
      const key = (tripleKey ?? doubleKey ?? "").trim();
      return formatMustacheValue(getByPath(resolved, key));
    },
  );
  return result.trim() || undefined;
}

/** Strip HTML tags to extract the text content (e.g. `<h1>Title</h1>` → `Title`). */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Drop Mustache tokens from a title, leaving only its static text
 * (`Categoria {{{id}}}` → `Categoria`). For contexts with no item data. */
export function stripMustacheTokens(title: string): string {
  return title
    .replace(/\{\{\{?[^{}]*\}?\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve-schema fills a titleless inline-union branch with `Option N`; that
 * synthetic default must not shadow the item's own fields when labelling. */
function isSyntheticBranchTitle(title: string): boolean {
  return /^Option \d+$/.test(title);
}

function readTitleByValue(
  obj: Record<string, unknown>,
  titleBy: string,
): string | undefined {
  if (titleBy.includes("{")) {
    return renderMustacheTemplate(titleBy, obj);
  }
  const value = obj[titleBy];
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => (entry == null ? "" : String(entry)))
      .filter(Boolean)
      .join(",");
    if (joined) return joined;
  }
  return undefined;
}

function baseArrayItemLabel(
  item: unknown,
  index: number,
  itemSchema?: SchemaProperty,
): string {
  if (typeof item === "string") return item.trim() ? item : `Item ${index + 1}`;
  if (typeof item === "number" || typeof item === "boolean") {
    return String(item);
  }
  if (item && typeof item === "object" && !Array.isArray(item)) {
    // Hidden items (`{ __resolveType: ".../multivariate.ts", variants: [{ value, rule: never }] }`)
    // should be labelled by the value they hide, not "Multivariate".
    let obj = arrayItemDisplayValue(item) as Record<string, unknown>;
    // Lazy-wrapped section items (`{ __resolveType: ".../Lazy.tsx", section: {...} }`)
    // should be labelled by the inner section, not "Lazy".
    const inner = lazyWrappedInner(obj);
    if (inner) {
      obj = inner;
    }
    if (itemSchema?.titleBy) {
      const fromTitleBy = readTitleByValue(obj, itemSchema.titleBy);
      if (fromTitleBy) return fromTitleBy;
    }
    // Inline unions carry titles per-branch, not on `items`: label by the active branch.
    if (itemSchema?.inlineUnionBranches?.length) {
      const idx = inferInlineUnionIndex(
        obj,
        itemSchema.inlineUnionBranches.map((b) => ({
          discriminators: b.discriminators,
          propertyKeys: Object.keys(b.schema?.properties ?? {}),
        })),
      );
      const branchTitle = itemSchema.inlineUnionBranches[idx]?.title;
      if (branchTitle && !isSyntheticBranchTitle(branchTitle)) {
        const rendered = renderMustacheTemplate(branchTitle, obj);
        if (rendered) return rendered;
        if (!branchTitle.includes("{")) return branchTitle;
      }
    }
    for (const key of [
      "name",
      "label",
      "title",
      "alt",
      "text",
      "href",
      "id",
      "key",
    ]) {
      const value = obj[key];
      // Skip whitespace-only strings (e.g. title: " ") so the item still gets a
      // meaningful label (falls through to the section name) and a stable,
      // non-blank breadcrumb crumb you can click into.
      if (typeof value === "string" && value.trim()) {
        // Rich-text / HTML fields store raw markup.  Use the plain-text
        // content as the label so array items show readable names and the
        // breadcrumb crumb stays stable for navigation.
        const fmt = itemSchema?.properties?.[key]?.format;
        if (fmt === "rich-text" || fmt === "html") {
          const text = stripHtmlTags(value);
          if (text) return text;
          continue; // empty after stripping → try next key
        }
        return value;
      }
      if (Array.isArray(value)) {
        const joined = value
          .map((entry) => (entry == null ? "" : String(entry)))
          .filter(Boolean)
          .join(",");
        if (joined) return joined;
      }
    }
    const resolveType = obj.__resolveType;
    if (typeof resolveType === "string" && resolveType) {
      return labelFromResolveType(resolveType);
    }
    if (itemSchema?.title) {
      const rendered = renderMustacheTemplate(itemSchema.title, obj);
      if (rendered) return rendered;
      if (!itemSchema.title.includes("{")) return itemSchema.title;
    }
  }
  return `Item ${index + 1}`;
}

/**
 * Base display labels for a whole array.
 *
 * Two items with no distinguishing field share a label — which is fine, and
 * deliberately so: array items are addressed by their index (the breadcrumb
 * crumb carries `itemIndex` — see `Crumb` in schema-form-breadcrumb.ts), never
 * by a unique label, and the list rows / drag overlay open an item by its
 * `entry.index`. So the displayed label stays clean — no positional " N" suffix
 * ever reaches the UI, even when items collide.
 */
export function getArrayItemDisplayLabels(
  items: unknown[],
  itemSchema?: SchemaProperty,
): string[] {
  return items.map((item, i) => baseArrayItemLabel(item, i, itemSchema));
}

/** Base display label for a single array item. */
export function getArrayItemLabel(
  item: unknown,
  index: number,
  itemSchema?: SchemaProperty,
): string {
  return baseArrayItemLabel(item, index, itemSchema);
}

function getArrayItemImageTemplate(
  itemSchema?: SchemaProperty,
): string | undefined {
  if (!itemSchema) return undefined;
  if (typeof itemSchema.image === "string" && itemSchema.image.includes("{")) {
    return itemSchema.image;
  }
  const imageSchema = itemSchema.properties?.image;
  if (!imageSchema) return undefined;
  if (imageSchema.format === "image-uri") return "{{{image}}}";
  const nested = imageSchema.properties;
  if (nested?.mobile) return "{{{image.mobile}}}";
  if (nested?.desktop) return "{{{image.desktop}}}";
  return "{{{image}}}";
}

export function getArrayItemImageSrc(
  item: unknown,
  itemSchema?: SchemaProperty,
): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item))
    return undefined;
  const template = getArrayItemImageTemplate(itemSchema);
  if (!template) return undefined;
  const rendered = renderMustacheTemplate(
    template,
    item as Record<string, unknown>,
  );
  if (!rendered) return undefined;
  const candidate = extractUrl(rendered) || rendered;
  return safeEditorImageUrl(candidate);
}
