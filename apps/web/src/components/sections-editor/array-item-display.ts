import { arrayItemDisplayValue } from "./array-item-hidden";
import { lazyWrappedInner } from "./block-ref-field-utils";
import { extractUrl } from "./fields/extract-url";
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

function formatMustacheValue(value: unknown): string {
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
 * Normalize a label the same way breadcrumb matching does (`labelsMatch` in
 * schema-form-breadcrumb.ts) so collision detection here agrees with crumb
 * resolution there. Duplicated locally rather than imported to avoid a cyclic
 * dependency (that module already imports from this one).
 */
function normalizeLabel(label: string): string {
  return label.normalize("NFC").trim();
}

/**
 * Display labels for a whole array, disambiguated so every label is unique.
 *
 * When an item's base label is shared by another item (e.g. an object array
 * with no name/title field, so every row falls back to the item schema's static
 * `title`), the label is suffixed with the item's position. Uniqueness is not
 * cosmetic: the breadcrumb addresses an array item by its label, and the only
 * other handle — the transiently-opened index in `ArrayField` — is reset
 * whenever the form subtree remounts (a `formResetKey` bump on back/breadcrumb
 * navigation). A non-unique label would then collapse every item back to the
 * first one on the next remount, so the editor appears to show the same content
 * for every item.
 *
 * Computed as a set (not per item) so the result is globally unique and
 * deterministic in `(items, itemSchema)` — the crumb built from this list
 * re-resolves to the same index even when a positional suffix happens to equal
 * another row's literal label. Comparison uses `normalizeLabel` to match the
 * resolver, so NFC/NFD and whitespace near-duplicates disambiguate too.
 */
export function getArrayItemLabels(
  items: unknown[],
  itemSchema?: SchemaProperty,
): string[] {
  const bases = items.map((item, i) => baseArrayItemLabel(item, i, itemSchema));
  const baseCounts = new Map<string, number>();
  for (const base of bases) {
    const key = normalizeLabel(base);
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  return bases.map((base, i) => {
    let label =
      (baseCounts.get(normalizeLabel(base)) ?? 0) > 1
        ? `${base} ${i + 1}`
        : base;
    // A suffixed label can still coincide with another row's literal label;
    // keep extending (positions are unique, so this terminates quickly) until
    // the final set has no duplicates.
    while (seen.has(normalizeLabel(label))) label = `${label} ${i + 1}`;
    seen.add(normalizeLabel(label));
    return label;
  });
}

/**
 * Plain per-item base labels for a whole array, WITHOUT the positional
 * disambiguation suffix that {@link getArrayItemLabels} adds.
 *
 * Use this for pure display surfaces that address the item some other way — the
 * list rows and the drag overlay open an item by its `entry.index`, never by its
 * label, so two rows sharing a base label ("Cozinha – Festival da CASA") is
 * harmless there and the synthetic " N" suffix is just visual noise.
 *
 * Do NOT use it anywhere a breadcrumb crumb is built or resolved: the crumb
 * addresses an item by label, so it MUST stay unique — see
 * {@link getArrayItemLabels}.
 */
export function getArrayItemDisplayLabels(
  items: unknown[],
  itemSchema?: SchemaProperty,
): string[] {
  return items.map((item, i) => baseArrayItemLabel(item, i, itemSchema));
}

/**
 * Display label for a single array item. Pass `siblings` (the whole array) to
 * get a label disambiguated against the others — see {@link getArrayItemLabels}.
 * Callers that build or resolve a breadcrumb crumb MUST pass `siblings` so the
 * built and resolved labels agree; only genuinely single-item callers omit it.
 */
export function getArrayItemLabel(
  item: unknown,
  index: number,
  itemSchema?: SchemaProperty,
  siblings?: unknown[],
): string {
  if (!siblings || siblings.length < 2) {
    return baseArrayItemLabel(item, index, itemSchema);
  }
  return (
    getArrayItemLabels(siblings, itemSchema)[index] ??
    baseArrayItemLabel(item, index, itemSchema)
  );
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
