import { getArrayItemLabels } from "./array-item-display";
import { isPageMultivariateSectionArrayField } from "./page-variants";
import type { SchemaProperty } from "./resolve-schema";
import { unwrapBlockReference } from "./unwrap-section";

function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Normalize labels so breadcrumb matching survives NFC/NFD differences (e.g. `ª`). */
export function normalizeBreadcrumbLabel(label: string): string {
  return label.normalize("NFC").trim();
}

function labelsMatch(a: string, b: string): boolean {
  return normalizeBreadcrumbLabel(a) === normalizeBreadcrumbLabel(b);
}

/** Looser comparison that ignores spaces and casing — handles humanize("textSeo") = "Text Seo" vs schema title "TextSeo". */
function labelsMatchLoose(a: string, b: string): boolean {
  return (
    normalizeBreadcrumbLabel(a).replace(/\s+/g, "").toLowerCase() ===
    normalizeBreadcrumbLabel(b).replace(/\s+/g, "").toLowerCase()
  );
}

/**
 * Whether the array's own label must stay in the breadcrumb trail so the item
 * remains uniquely addressable.
 *
 * A trail of just `[itemLabel]` can't say WHICH array an item came from. That's
 * fine for the common case — the array is an implementation detail whose list is
 * already shown inline in the parent — but it breaks when the crumb is
 * ambiguous, so the array label is kept as a disambiguator when EITHER:
 *
 * - a sibling array/drill-down field exists in the same scope
 *   ({@link resolveActiveFieldKey} would otherwise pick the first sibling whose
 *   item shares the crumb — e.g. two label-less arrays both fall back to
 *   "Item N"); or
 * - the item's own label collides with the array's display label or property
 *   key — {@link breadcrumbPathForActiveField} strips a head crumb that matches
 *   either, which would drop the sole crumb and lose the selection.
 */
function arrayCrumbNeededForDisambiguation(
  arrayLabel: string,
  itemLabel: string,
  opts?: { arrayKey?: string; hasSiblingDrillDownFields?: boolean },
): boolean {
  return (
    (opts?.hasSiblingDrillDownFields ?? false) ||
    labelsMatch(itemLabel, arrayLabel) ||
    (opts?.arrayKey != null && labelsMatch(itemLabel, opts.arrayKey))
  );
}

/**
 * Breadcrumb trail when opening an array item.
 *
 * The array field itself is an implementation detail: its list is already shown
 * inline in the parent form, so drilling into an item jumps straight from the
 * section to the item. We deliberately do NOT add the array's own label as a
 * crumb — it would show a redundant "list only" step the user has to click back
 * through (and, once nested, could even appear twice). Resolution
 * ({@link resolveActiveFieldKey}, {@link resolveArrayItemSelection}) already
 * matches an item by its label without the array crumb present.
 *
 * The exception is when the crumb would be ambiguous — see
 * {@link arrayCrumbNeededForDisambiguation}: then the array label is kept so the
 * right array (and item) still resolves.
 */
export function buildArrayDrillDownBreadcrumb(
  breadcrumbPath: string[],
  arrayLabel: string,
  itemLabel: string,
  opts?: { arrayKey?: string; hasSiblingDrillDownFields?: boolean },
): string[] {
  const normalizedItem = normalizeBreadcrumbLabel(itemLabel);
  if (
    breadcrumbPath.some(
      (crumb) =>
        labelsMatch(crumb, normalizedItem) || labelsMatch(crumb, itemLabel),
    )
  ) {
    return breadcrumbPath;
  }
  const trail = [...breadcrumbPath];
  if (
    arrayCrumbNeededForDisambiguation(arrayLabel, itemLabel, opts) &&
    !trail.some((crumb) => labelsMatch(crumb, arrayLabel))
  ) {
    trail.push(arrayLabel);
  }
  trail.push(itemLabel);
  return trail;
}

/**
 * Crumbs the active field consumed — i.e. the prefix {@link breadcrumbPathForActiveField}
 * dropped from the front of `breadcrumbPath` to produce `fieldBreadcrumbPath`.
 *
 * The active field receives a breadcrumb relative to itself but reports changes
 * through an `onBreadcrumbChange` that writes the GLOBAL trail. Re-prepend this
 * prefix to those reports so a child rebuilding the trail (e.g. ArrayField
 * syncing an item's label while typing) doesn't silently drop the ancestor
 * crumbs — which otherwise collapses the trail when a consumed crumb equals the
 * child's own crumb (array labelled "Banner" + lone item labelled "Banner").
 */
export function consumedBreadcrumbPrefix(
  breadcrumbPath: string[],
  fieldBreadcrumbPath: string[],
): string[] {
  return breadcrumbPath.slice(
    0,
    breadcrumbPath.length - fieldBreadcrumbPath.length,
  );
}

/**
 * Drop crumbs consumed by the active field so children see a relative trail.
 *
 * NOTE: {@link consumedBreadcrumbPrefix} reconstructs the dropped prefix purely
 * by length difference, which relies on the return value always being a
 * front-suffix of `breadcrumbPath` (this only ever drops the leading crumb).
 * Keep it that way — dropping from the middle or rewriting a crumb would make
 * that reconstruction silently wrong.
 */
export function breadcrumbPathForActiveField(
  activeKey: string,
  schema: SchemaProperty,
  breadcrumbPath: string[],
): string[] {
  if (breadcrumbPath.length === 0) return breadcrumbPath;
  const label = fieldDisplayLabel(activeKey, schema);
  const head = breadcrumbPath[0]!;
  if (labelsMatch(head, label) || labelsMatch(head, activeKey)) {
    return breadcrumbPath.slice(1);
  }
  return breadcrumbPath;
}

export function fieldDisplayLabel(key: string, schema: SchemaProperty): string {
  return schema.title ?? humanize(key);
}

/**
 * Header crumb index the top-bar back button ("<") should navigate to.
 *
 * Normally "back" targets the parent of the last crumb (`crumbCount - 2`). But a
 * multivariate section renders its variant list AND the selected variant's form
 * as one combined view, so the section-label crumb and the variant-label crumb
 * collapse to the same navigation level (both map to `fieldBreadcrumbs = []`). At
 * that top level `crumbCount - 2` points at the redundant section crumb, so back
 * only clears the (already empty) field trail and appears to do nothing. Treat the
 * variant top as a direct child of the section list instead, so back exits the
 * section (index 0).
 */
export function headerBackTargetIndex(
  crumbCount: number,
  opts: { isMultivariateSectionTop: boolean },
): number {
  if (opts.isMultivariateSectionTop) return 0;
  return crumbCount - 2;
}

/** Map a header crumb index to the breadcrumb trail (`headerCrumbs = [title, ...breadcrumbs]`). */
export function breadcrumbsForHeaderClick(
  breadcrumbs: string[],
  headerIndex: number,
): string[] {
  if (headerIndex <= 0) return [];
  return breadcrumbs.slice(0, headerIndex);
}

export function findBreadcrumbLabelIndex(
  path: string[],
  targetLabel: string,
): number {
  const normalized = normalizeBreadcrumbLabel(targetLabel);
  return path.findIndex(
    (crumb) => normalizeBreadcrumbLabel(crumb) === normalized,
  );
}

/**
 * Position of the open array item's own crumb inside `breadcrumbPath`, derived
 * from the `innerPath` that {@link resolveArrayItemSelection} returned for it.
 * The item crumb always sits immediately before its inner trail, so this is
 * `length - innerPath.length - 1`.
 *
 * Use this — not `findBreadcrumbLabelIndex(oldLabel)` — to rewrite the crumb
 * when the item's label changes while it is open. A label lookup breaks the
 * moment the label churns: once the old text is gone it finds nothing and the
 * crumb is left stale (which then re-resolves to a colliding sibling — the
 * "editing a duplicate's title snaps back to the original" bug); and when the
 * item's label equals an earlier crumb (array label == item label), it rewrites
 * the wrong (earlier) crumb. The position is stable regardless of the text.
 */
export function arrayItemCrumbIndex(
  breadcrumbPath: string[],
  innerPath: string[],
): number {
  return breadcrumbPath.length - innerPath.length - 1;
}

/** Breadcrumb drill-down applies to array fields only (not nested objects). */
export function isArrayDrillDownField(
  schema: SchemaProperty,
  value?: unknown,
): boolean {
  if (schema.type === "array" && schema.items) return true;
  if (isPageMultivariateSectionArrayField(schema)) return true;
  return Array.isArray(value);
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// A drilled item is addressed by its display label, which for the common case
// comes from one of these high-signal naming fields. We match ownership ONLY
// against these (not the full getArrayItemLabel fallback chain) so a coincidental
// `href`/`id`/`key` value — or a plain string in an unrelated primitive array —
// can't spuriously claim to own the crumb.
const OWNERSHIP_LABEL_KEYS = ["name", "label", "title", "alt"] as const;

function itemOwnershipLabel(item: unknown): string | undefined {
  if (item == null || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const obj = item as Record<string, unknown>;
  for (const key of OWNERSHIP_LABEL_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * Whether a (block-ref) field's inline value contains — at any nesting level —
 * an object array item whose naming field matches `crumb`.
 *
 * Drilling into an array item that lives inside a loader's config produces a
 * bare `[itemLabel]` trail (the array's own label is omitted, and the loader's
 * label isn't in the trail either). Without this, a multi-field section can't
 * tell which field owns the item, so {@link resolveActiveFieldKeyInScope}
 * returns null and the panel keeps showing every sibling prop instead of
 * narrowing to the item.
 *
 * Deliberately conservative — matches only object items via
 * {@link OWNERSHIP_LABEL_KEYS} (no item schema is available here). Items labeled
 * via a custom `titleBy`, via `text`/`href`/`id`, or primitive-array items are
 * NOT detected; those degrade to the pre-fix behavior (all siblings shown)
 * rather than risk narrowing to the wrong loader. Bounded by depth and a shared
 * node budget so a large loader config can't stall a render.
 */
function valueOwnsItemCrumb(
  value: unknown,
  crumb: string,
  budget = { n: 4000 },
  depth = 0,
): boolean {
  if (
    depth > 4 ||
    budget.n <= 0 ||
    value == null ||
    typeof value !== "object"
  ) {
    return false;
  }
  // A colliding item's crumb carries a positional suffix ("Dup 1"), but the
  // ownership labels scanned here are bare (no item schema is available at this
  // nesting level), so also try the crumb with a trailing " N" stripped. This
  // only widens matching, and the actual item is still pinned downstream by the
  // suffix-aware resolveArrayItemSelection.
  const crumbBase = crumb.replace(/\s+\d+$/, "");
  if (Array.isArray(value)) {
    for (const item of value) {
      if (--budget.n <= 0) return false;
      const label = itemOwnershipLabel(item);
      if (
        label &&
        (labelsMatch(label, crumb) || labelsMatch(label, crumbBase))
      ) {
        return true;
      }
      if (valueOwnsItemCrumb(item, crumb, budget, depth + 1)) return true;
    }
    return false;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith("__")) continue;
    if (--budget.n <= 0) return false;
    if (valueOwnsItemCrumb(v, crumb, budget, depth + 1)) return true;
  }
  return false;
}

/** Resolve which property at this level should be shown for the breadcrumb trail. */
function resolveActiveFieldKeyInScope(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown>,
  breadcrumbPath: string[],
  decofile?: Record<string, unknown>,
): string | null {
  if (breadcrumbPath.length === 0) return null;
  const head = breadcrumbPath[0]!;

  for (const key of keys) {
    const schema = properties[key];
    if (!schema || !isArrayDrillDownField(schema, objValue[key])) continue;
    const label = fieldDisplayLabel(key, schema);
    if (labelsMatch(head, label) || labelsMatch(head, key)) return key;
    if (
      breadcrumbPath.some(
        (crumb) => labelsMatch(crumb, label) || labelsMatch(crumb, key),
      )
    ) {
      return key;
    }
  }

  for (const key of keys) {
    const schema = properties[key];
    if (!schema || !isArrayDrillDownField(schema, objValue[key])) continue;
    const val = objValue[key];
    if (!Array.isArray(val)) continue;
    const labels = getArrayItemLabels(val, schema.items);
    if (labels.some((label) => labelsMatch(label, head))) return key;
  }

  for (const key of keys) {
    const schema = properties[key];
    if (schema?.type !== "object" || !schema.properties) continue;
    const childKeys = Object.keys(schema.properties);
    const childObj = asObjectRecord(objValue[key]);
    const label = fieldDisplayLabel(key, schema);

    const direct = resolveActiveFieldKeyInScope(
      childKeys,
      schema.properties,
      childObj,
      breadcrumbPath,
      decofile,
    );
    if (direct) return key;

    if (labelsMatch(head, label) || labelsMatch(head, key)) {
      const viaLabel = resolveActiveFieldKeyInScope(
        childKeys,
        schema.properties,
        childObj,
        breadcrumbPath.slice(1),
        decofile,
      );
      if (viaLabel) return key;
    }
  }

  // Inline-union fields ("A or B" plain-data unions) store the chosen branch's
  // fields flat on the value, so a nested array inside a branch (e.g.
  // `searchProps: Advanced | Cluster | …` whose Advanced branch has a
  // `selectedFacets: Facet[]`) drills into an item that writes a bare
  // `[itemLabel]` crumb — the union's own label never enters the trail. Recurse
  // into each branch's properties (against the same union value) so the crumb
  // resolves to this field; otherwise the panel falls back to showing every
  // sibling prop while the union field alone narrows to the item.
  for (const key of keys) {
    const schema = properties[key];
    if (
      schema?.type !== "inline-union" ||
      !schema.inlineUnionBranches?.length
    ) {
      continue;
    }
    const childObj = asObjectRecord(objValue[key]);
    const label = fieldDisplayLabel(key, schema);
    for (const branch of schema.inlineUnionBranches) {
      const branchProps = branch.schema?.properties;
      if (!branchProps) continue;
      const branchKeys = Object.keys(branchProps);

      const direct = resolveActiveFieldKeyInScope(
        branchKeys,
        branchProps,
        childObj,
        breadcrumbPath,
        decofile,
      );
      if (direct) return key;

      if (labelsMatch(head, label) || labelsMatch(head, key)) {
        const viaLabel = resolveActiveFieldKeyInScope(
          branchKeys,
          branchProps,
          childObj,
          breadcrumbPath.slice(1),
          decofile,
        );
        if (viaLabel) return key;
      }
    }
  }

  // Block-ref fields (loader/section selectors) can also be "drilled into"
  // via the breadcrumb path when the head matches the field's key or label.
  // This lets loader props like `page: ProductListingPage` participate in
  // breadcrumb navigation (e.g. path ["page", "selectedFacets", "productClusterIds"]
  // resolves to "page" at the SearchResult level).
  //
  // When multiple block-refs share the same label (e.g. both "asideMenu"
  // and "content" have schema title "Section"), disambiguate by checking
  // whether the block-ref's VALUE contains a key that matches the next
  // breadcrumb crumb.  The one whose data actually owns the nested field
  // wins; the rest are kept as a fallback.
  let blockRefFallback: string | null = null;
  for (const key of keys) {
    const schema = properties[key];
    if (schema?.type !== "block-ref") continue;
    const fieldLabel = fieldDisplayLabel(key, schema);
    if (head !== fieldLabel && head !== key) {
      // The crumb isn't the loader's own label, but the drilled item may live
      // in an array inside the loader's config — narrow to the loader so its own
      // form can then narrow to the item (instead of the section showing every
      // sibling prop of the previous level). For a global/saved loader the value
      // is just a `{ __resolveType }` reference, so resolve its data from the
      // decofile before scanning.
      const rawVal = objValue[key];
      const saved = decofile ? unwrapBlockReference(rawVal, decofile) : null;
      if (valueOwnsItemCrumb(saved?.data ?? rawVal, head)) return key;
      continue;
    }

    if (breadcrumbPath.length > 1) {
      const val = objValue[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const nextCrumb = breadcrumbPath[1]!;
        const hasInnerMatch = Object.keys(val as Record<string, unknown>).some(
          (k) =>
            !k.startsWith("__") &&
            (labelsMatchLoose(humanize(k), nextCrumb) ||
              labelsMatchLoose(k, nextCrumb)),
        );
        if (hasInnerMatch) return key;
      }
    }

    if (!blockRefFallback) blockRefFallback = key;
  }
  if (blockRefFallback) return blockRefFallback;

  return null;
}

/** Resolve which top-level property is active for the current breadcrumb trail. */
export function resolveActiveFieldKey(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown>,
  breadcrumbPath: string[],
  decofile?: Record<string, unknown>,
): string | null {
  return resolveActiveFieldKeyInScope(
    keys,
    properties,
    objValue,
    breadcrumbPath,
    decofile,
  );
}

/** True when the breadcrumb trail targets a field inside this object. */
export function isBreadcrumbInsideObject(
  fieldKey: string,
  label: string,
  schema: SchemaProperty,
  objValue: Record<string, unknown>,
  breadcrumbPath: string[],
  decofile?: Record<string, unknown>,
): boolean {
  if (breadcrumbPath.length === 0 || !schema.properties) return false;

  const keys = Object.keys(schema.properties);
  if (
    resolveActiveFieldKeyInScope(
      keys,
      schema.properties,
      objValue,
      breadcrumbPath,
      decofile,
    )
  ) {
    return true;
  }

  const head = breadcrumbPath[0]!;
  if (!labelsMatch(head, label) && !labelsMatch(head, fieldKey)) return false;

  return (
    breadcrumbPath.length > 1 ||
    resolveActiveFieldKeyInScope(
      keys,
      schema.properties,
      objValue,
      breadcrumbPath.slice(1),
      decofile,
    ) !== null
  );
}

/**
 * Find the array item whose label matches `crumb`.
 *
 * Array items are addressed in the breadcrumb by their (mutable, non-unique)
 * display label, so two items can resolve to the same crumb — e.g. after
 * duplicating an item, or when the label field (name/title/alt/…) is edited to
 * a value another item already uses. A plain `findIndex` always returns the
 * FIRST such item, which yanks the editor away from a later item the moment its
 * label collides with an earlier sibling (dropping focus mid-typing).
 *
 * `preferredIndex` is the item the caller currently has open. When it still
 * matches the crumb we keep it, so editing a colliding label never snaps
 * selection to a different row.
 */
function findItemIndexForCrumb(
  items: unknown[],
  itemSchema: SchemaProperty | undefined,
  crumb: string,
  preferredIndex?: number | null,
): number {
  const labels = getArrayItemLabels(items, itemSchema);
  const preferred = preferredIndex != null ? labels[preferredIndex] : undefined;
  if (preferred !== undefined && labelsMatch(preferred, crumb)) {
    return preferredIndex!;
  }
  return labels.findIndex((label) => labelsMatch(label, crumb));
}

export function resolveArrayItemSelection(
  label: string,
  breadcrumbPath: string[],
  items: unknown[],
  itemSchema: SchemaProperty | undefined,
  preferredIndex?: number | null,
): { index: number; innerPath: string[] } | null {
  if (breadcrumbPath.length === 0) return null;

  for (let pi = 0; pi < breadcrumbPath.length; pi++) {
    const crumb = breadcrumbPath[pi]!;
    const index = findItemIndexForCrumb(
      items,
      itemSchema,
      crumb,
      preferredIndex,
    );
    if (index >= 0) {
      return { index, innerPath: breadcrumbPath.slice(pi + 1) };
    }
  }

  const labelIndex = breadcrumbPath.findIndex((crumb) =>
    labelsMatch(crumb, label),
  );
  if (labelIndex >= 0 && breadcrumbPath.length > labelIndex + 1) {
    const itemCrumb = breadcrumbPath[labelIndex + 1]!;
    const index = findItemIndexForCrumb(
      items,
      itemSchema,
      itemCrumb,
      preferredIndex,
    );
    if (index >= 0) {
      return { index, innerPath: breadcrumbPath.slice(labelIndex + 2) };
    }
  }

  return null;
}
