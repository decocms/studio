import {
  getArrayItemDisplayLabels,
  getArrayItemLabel,
} from "./array-item-display";
import { isPageMultivariateSectionArrayField } from "./page-variants";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "./resolve-schema";
import { unwrapBlockReference } from "./unwrap-section";

/**
 * A breadcrumb crumb. Field/context crumbs (page name, section label, an
 * ancestor field's disambiguated label) are plain strings. An array-item crumb
 * additionally carries the item's exact array index, so it re-resolves to that
 * item after a form remount without leaking a positional number into the label
 * the UI renders — the crumb is addressed by `itemIndex`, displayed by `label`.
 *
 * When the array needs disambiguating (a sibling drill-down array in the same
 * scope, or an item label that collides with the array's own label/key), the
 * array's label rides on the item crumb as `arrayLabel` rather than as a
 * SEPARATE crumb. That keeps resolution unambiguous WITHOUT creating a standalone
 * "array list only" navigation stop the user would have to click back through —
 * the array's list is already shown inline in its parent form.
 */
export type Crumb =
  | string
  | { label: string; itemIndex: number; arrayLabel?: string };

/** The human-visible text of a crumb (the label part of an item crumb). */
export function crumbLabel(crumb: Crumb): string {
  return typeof crumb === "string" ? crumb : crumb.label;
}

/** Whether a crumb addresses an array item (carries an `itemIndex`). */
function isItemCrumb(
  crumb: Crumb,
): crumb is { label: string; itemIndex: number; arrayLabel?: string } {
  return typeof crumb === "object";
}

/** The disambiguating array label riding on an item crumb, if any. */
function crumbArrayLabel(crumb: Crumb): string | undefined {
  return isItemCrumb(crumb) ? crumb.arrayLabel : undefined;
}

/**
 * Rewrite an array-item crumb's display label at `itemIndex`, preserving any
 * `arrayLabel` disambiguator on the existing crumb. `existing` may be undefined
 * or (defensively) a plain string; either way a fresh item crumb is returned.
 * The single place crumb shape is (re)built for a label change — used by both
 * `ArrayField.updateItem` (label edit) and `ArrayField.arrayItemPrefix`.
 */
export function withItemCrumbLabel(
  existing: Crumb | undefined,
  label: string,
  itemIndex: number,
): Crumb {
  return existing != null && typeof existing === "object"
    ? { ...existing, label, itemIndex }
    : { label, itemIndex };
}

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

/**
 * Prepend `label` to a breadcrumb `trail` unless it's already the head crumb
 * (NFC-insensitive). Used to stamp the disambiguated ancestor label onto a drill
 * trail so the resolver can tell same-titled sibling props apart.
 */
export function prependCrumbIfAbsent(label: string, trail: Crumb[]): Crumb[] {
  if (
    trail.length > 0 &&
    normalizeBreadcrumbLabel(crumbLabel(trail[0]!)) ===
      normalizeBreadcrumbLabel(label)
  ) {
    return trail;
  }
  return [label, ...trail];
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
  opts?: {
    arrayKey?: string;
    hasSiblingDrillDownFields?: boolean;
    itemLabelFromSchema?: boolean;
  },
): boolean {
  return (
    (opts?.hasSiblingDrillDownFields ?? false) ||
    // Schema-only (titleBy/inline-union) labels can't be recomputed by a parent loader's resolver, so fold the array label as an invisible disambiguator.
    (opts?.itemLabelFromSchema ?? false) ||
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
 * standalone crumb — it would show a redundant "list only" step the user has to
 * click back through (and, once nested, could even appear twice). Resolution
 * ({@link resolveActiveFieldKey}, {@link resolveArrayItemSelection}) already
 * matches an item by its label without the array crumb present.
 *
 * When the crumb would be ambiguous — see
 * {@link arrayCrumbNeededForDisambiguation} — the array label still has to travel
 * with the trail so the right array (and item) resolves. It rides on the item
 * crumb as `arrayLabel` INSTEAD of as a separate crumb, so disambiguation costs
 * no extra navigation stop: back from the item lands on the array's parent form,
 * never on a bare array list.
 */
export function buildArrayDrillDownBreadcrumb(
  breadcrumbPath: Crumb[],
  arrayLabel: string,
  itemLabel: string,
  itemIndex: number,
  opts?: {
    arrayKey?: string;
    hasSiblingDrillDownFields?: boolean;
    itemLabelFromSchema?: boolean;
  },
): Crumb[] {
  const normalizedItem = normalizeBreadcrumbLabel(itemLabel);
  if (
    breadcrumbPath.some(
      (crumb) =>
        labelsMatch(crumbLabel(crumb), normalizedItem) ||
        labelsMatch(crumbLabel(crumb), itemLabel),
    )
  ) {
    return breadcrumbPath;
  }
  const itemCrumb = arrayCrumbNeededForDisambiguation(
    arrayLabel,
    itemLabel,
    opts,
  )
    ? { label: itemLabel, itemIndex, arrayLabel }
    : { label: itemLabel, itemIndex };
  return [...breadcrumbPath, itemCrumb];
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
  breadcrumbPath: Crumb[],
  fieldBreadcrumbPath: Crumb[],
): Crumb[] {
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
  breadcrumbPath: Crumb[],
  overrideLabel?: string,
): Crumb[] {
  if (breadcrumbPath.length === 0) return breadcrumbPath;
  const first = breadcrumbPath[0]!;
  // Only a field/context crumb (a plain string — an object's disambiguated label
  // or, formerly, a standalone array crumb) can be the active field's OWN crumb
  // to consume. An item crumb (carries `itemIndex`) is the array's selection and
  // must pass through untouched — otherwise, now that the array's disambiguator
  // rides ON the item crumb as `arrayLabel`, an item whose label equals the
  // array's label/key would be stripped here, leaving ArrayField an empty trail
  // and making the item impossible to open (it snaps back to the list).
  if (isItemCrumb(first)) return breadcrumbPath;
  const label = overrideLabel ?? fieldDisplayLabel(activeKey, schema);
  const head = crumbLabel(first);
  if (labelsMatch(head, label) || labelsMatch(head, activeKey)) {
    return breadcrumbPath.slice(1);
  }
  return breadcrumbPath;
}

export function fieldDisplayLabel(key: string, schema: SchemaProperty): string {
  return schema.title ?? humanize(key);
}

/**
 * Display label for a property within its sibling group, disambiguated by key
 * when two siblings share the same {@link fieldDisplayLabel} (e.g. `shelfProps`
 * and `shelfPropsOffer` both `$ref` the `ProductShelfProps` interface, so both
 * inherit its `title`). A collision falls back to `humanize(key)` so the fields
 * stay distinguishable in the panel AND the breadcrumb resolver can tell which
 * sibling a crumb belongs to. No-op (returns the plain label) when unique.
 */
export function siblingFieldLabel(
  key: string,
  keys: string[],
  properties: Record<string, SchemaProperty>,
): string {
  const schema = properties[key];
  if (!schema) return humanize(key);
  const base = fieldDisplayLabel(key, schema);
  const collides = keys.some((k) => {
    if (k === key) return false;
    const other = properties[k];
    return other != null && fieldDisplayLabel(k, other) === base;
  });
  return collides ? humanize(key) : base;
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
  breadcrumbs: Crumb[],
  headerIndex: number,
): Crumb[] {
  if (headerIndex <= 0) return [];
  return breadcrumbs.slice(0, headerIndex);
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

/**
 * Whether an array (drill-down) field exists anywhere inside this object schema.
 * Depth-bounded so a deeply nested schema can't stall the check. Uses the
 * canonical {@link isArrayDrillDownField} for the leaf test so "drill-down array"
 * means the same thing here as in the resolver (which gates on it too).
 */
function schemaHasNestedArrayField(schema: SchemaProperty, depth = 0): boolean {
  if (depth > 6 || !schema.properties) return false;
  for (const key of Object.keys(schema.properties)) {
    const child = schema.properties[key];
    if (!child) continue;
    if (isArrayDrillDownField(child)) return true;
    if (
      child.type === "object" &&
      schemaHasNestedArrayField(child, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a field VALUE contains — at any nesting level — a drill-down array (an
 * array with ≥1 object item). The value-based counterpart to
 * {@link schemaHasNestedArrayField}, needed for block-ref (loader) fields whose
 * nested arrays live in the resolved value, not the field's own schema.
 */
function valueHasNestedDrillArray(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some(
      (item) =>
        item != null && typeof item === "object" && !Array.isArray(item),
    );
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith("__")) continue;
    if (valueHasNestedDrillArray(v, depth + 1)) return true;
  }
  return false;
}

/**
 * The sibling field keys in this scope that need their own label stamped onto the
 * breadcrumb trail when drilling into a nested array item, to stay unambiguous.
 *
 * A key qualifies when it holds a nested drill-down array AND at least one sibling
 * also does: a bare `[…, itemLabel]` trail then matches the nested array in BOTH,
 * so {@link resolveActiveFieldKey} can't tell them apart and the panel falls back
 * to showing every sibling. Stamping the disambiguated label makes the trail name
 * the right one — the resolver's strong-match path then pins it. Two shapes hit
 * this: object siblings (`shelfProps` / `shelfPropsOffer`, each with
 * `cardLayout.productTags`) and block-ref loaders (a PLP `page` + a
 * `RangePriceProps`, both carrying `selectedFacets`).
 *
 * Object siblings are detected by SCHEMA ({@link schemaHasNestedArrayField});
 * block-ref/loader siblings by their resolved VALUE
 * ({@link valueHasNestedDrillArray}), since their arrays aren't in the field
 * schema. Computed once per scope so callers don't re-walk per rendered field.
 */
export function siblingsNeedingAncestorCrumb(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown> = {},
): Set<string> {
  const holders = keys.filter((key) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "object" && schemaHasNestedArrayField(schema)) {
      return true;
    }
    // Only CONTAINER fields (a loader/block-ref whose value is a non-array object) get a standalone ancestor crumb; a direct array disambiguates via its folded arrayLabel.
    const v = objValue[key];
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      return valueHasNestedDrillArray(v);
    }
    return false;
  });
  return holders.length > 1 ? new Set(holders) : new Set();
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The ownership label of an array item — the SAME label {@link getArrayItemLabel}
 * displays it by, so ownership matches exactly the crumb the user drilled into (a
 * crumb IS a display label). This covers every data-derived source at once —
 * name/label/title/alt, text/href/id/key, and `__resolveType` — instead of a
 * hand-picked subset that silently dropped `selectedFacets`, category navs, etc.
 *
 * Only OBJECT items get a label: primitive array items can't be drilled into, so a
 * plain string in an unrelated array must never claim the crumb. The generic
 * `Item N` fallback names no field, so it's rejected too. The only residual blind
 * spot is a `titleBy`/inline-union label, which needs the item schema (absent
 * here) — those degrade to "all siblings shown", never to a wrong narrow.
 */
function itemOwnershipLabel(item: unknown, index: number): string | undefined {
  if (item == null || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const label = getArrayItemLabel(item, index);
  return label === `Item ${index + 1}` ? undefined : label;
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
 * Ownership uses {@link itemOwnershipLabel} — the item's real display label — so
 * every data-derived label (name/label/title/alt, text/href/id/key,
 * `__resolveType`) matches, not a hand-picked subset. Only `titleBy`/inline-union
 * labels (schema-only, absent here) and primitive arrays stay undetected; those
 * degrade to "all siblings shown", never a wrong narrow. Bounded by depth and a
 * shared node budget so a large loader config can't stall a render.
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
  // The crumb passed here is already the item's base label (callers unwrap the
  // crumb via crumbLabel), and the ownership labels scanned here are bare too, so
  // a direct match suffices. The actual item is still pinned downstream by the
  // index-carrying resolveArrayItemSelection.
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (--budget.n <= 0) return false;
      const label = itemOwnershipLabel(item, i);
      if (label && labelsMatch(label, crumb)) {
        return true;
      }
      if (valueOwnsItemCrumb(item, crumb, budget, depth + 1)) return true;
    }
    return false;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith("__")) continue;
    if (--budget.n <= 0) return false;
    // The crumb may name a nested container FIELD (a global loader ref's drilled `selectedFacets` array writes a "Selected Facets" field crumb), not an item.
    if (
      (Array.isArray(v) || (v != null && typeof v === "object")) &&
      (labelsMatchLoose(humanize(k), crumb) || labelsMatchLoose(k, crumb))
    ) {
      return true;
    }
    if (valueOwnsItemCrumb(v, crumb, budget, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a block-ref field's target SCHEMA declares a drill-down array whose
 * display title (or key) matches `arrayLabel`.
 *
 * A drilled array item carries its array's SCHEMA `@title` as the crumb's
 * `arrayLabel` (e.g. "Cupons da PDP" for `pdpCupons: CupomPDPProps[]`). The
 * value-only owner scan ({@link valueOwnsItemCrumb}) can't see that title — it
 * humanizes the KEY (`pdpCupons` → "Pdp Cupons") — and can't recompute a
 * `@titleBy` item label (`couponCode`) without the item schema, so a section whose
 * array is titled and whose items are `@titleBy`-labelled goes unclaimed and
 * resolution drifts to a sibling block-ref (the "drilling a coupon opens the
 * fallback's categories" bug). Resolving the target schema restores the match by
 * the array's real title, mirroring the top-level `arrayLabel` disambiguation in
 * {@link resolveActiveFieldKeyInScope}. Depth-bounded for nested config objects.
 */
function blockRefSchemaOwnsArrayLabel(
  data: unknown,
  arrayLabel: string,
  meta: LiveMeta | undefined,
  depth = 0,
): boolean {
  if (!meta || depth > 4 || data == null || typeof data !== "object") {
    return false;
  }
  const resolveType = (data as Record<string, unknown>).__resolveType;
  if (typeof resolveType !== "string" || !resolveType) return false;
  const props = resolveSchema(resolveType, meta)?.properties;
  if (!props) return false;
  const keys = Object.keys(props);
  for (const key of keys) {
    const child = props[key];
    if (!child) continue;
    if (isArrayDrillDownField(child)) {
      const title = siblingFieldLabel(key, keys, props);
      if (labelsMatch(title, arrayLabel) || labelsMatch(key, arrayLabel)) {
        return true;
      }
    }
    // Follow inner block refs so a Lazy-wrapped section's array is still found.
    const childValue = (data as Record<string, unknown>)[key];
    if (
      childValue != null &&
      typeof childValue === "object" &&
      !Array.isArray(childValue) &&
      blockRefSchemaOwnsArrayLabel(childValue, arrayLabel, meta, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

/** Resolve which property at this level should be shown for the breadcrumb trail. */
function resolveActiveFieldKeyInScope(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown>,
  breadcrumbPath: Crumb[],
  decofile?: Record<string, unknown>,
  meta?: LiveMeta,
): string | null {
  if (breadcrumbPath.length === 0) return null;
  const head = crumbLabel(breadcrumbPath[0]!);

  for (const key of keys) {
    const schema = properties[key];
    if (!schema || !isArrayDrillDownField(schema, objValue[key])) continue;
    const label = siblingFieldLabel(key, keys, properties);
    if (labelsMatch(head, label) || labelsMatch(head, key)) return key;
    // The array's disambiguating label rides on an item crumb's `arrayLabel`
    // (see buildArrayDrillDownBreadcrumb), so match against that too — it's what
    // tells sibling drill-down arrays (e.g. `productTags` vs `productSquareTags`)
    // apart now that the array label is no longer a standalone crumb.
    if (
      breadcrumbPath.some((crumb) => {
        if (
          labelsMatch(crumbLabel(crumb), label) ||
          labelsMatch(crumbLabel(crumb), key)
        ) {
          return true;
        }
        const arrayLabel = crumbArrayLabel(crumb);
        return (
          arrayLabel != null &&
          (labelsMatch(arrayLabel, label) || labelsMatch(arrayLabel, key))
        );
      })
    ) {
      return key;
    }
  }

  for (const key of keys) {
    const schema = properties[key];
    if (!schema || !isArrayDrillDownField(schema, objValue[key])) continue;
    const val = objValue[key];
    if (!Array.isArray(val)) continue;
    const labels = getArrayItemDisplayLabels(val, schema.items);
    if (labels.some((label) => labelsMatch(label, head))) return key;
  }

  // Collect every object sibling that owns the trail rather than returning the
  // first. Two siblings that `$ref` the same interface (e.g. `shelfProps` /
  // `shelfPropsOffer`, both `ProductShelfProps`) have identical nested shapes,
  // so a shared crumb ("Free shipping", or a field-level "Card Layout")
  // matches BOTH. First-match-wins would silently narrow to the first and drill
  // the wrong prop; if the trail can't tell them apart, return null so the panel
  // keeps both visible instead of editing the wrong sibling. A crumb carrying the
  // disambiguated ancestor label (its `siblingFieldLabel`) matches exactly one.
  // A "strong" match is one where the head crumb NAMES this object sibling (its
  // disambiguated label or key), so it's consumed and we recurse into only this
  // sibling. A "loose" match is against the full trail — the item's own crumb
  // identifies it, but that crumb (or a nested array-label crumb like
  // "ProductTags") can match the same-shaped array in MULTIPLE siblings, so it's
  // inherently ambiguous. Strong matches take precedence: when a disambiguating
  // ancestor crumb pins one sibling, a loose match on another must not veto it.
  // Without this, drilling into `shelfProps.cardLayout.productTags[i]` while
  // `shelfPropsOffer.cardLayout.productTags` holds the same item — even WITH the
  // "Shelf Props" ancestor crumb present — resolves ambiguously (both own the
  // "ProductTags" crumb) and the panel shows every sibling mixed together.
  let strongMatch: string | null = null;
  let strongAmbiguous = false;
  let looseMatch: string | null = null;
  let looseAmbiguous = false;
  for (const key of keys) {
    const schema = properties[key];
    if (schema?.type !== "object" || !schema.properties) continue;
    const childKeys = Object.keys(schema.properties);
    const childObj = asObjectRecord(objValue[key]);
    const label = siblingFieldLabel(key, keys, properties);

    if (labelsMatch(head, label) || labelsMatch(head, key)) {
      const matchedStrong =
        resolveActiveFieldKeyInScope(
          childKeys,
          schema.properties,
          childObj,
          breadcrumbPath.slice(1),
          decofile,
          meta,
        ) != null;
      if (matchedStrong) {
        if (strongMatch === null) strongMatch = key;
        else strongAmbiguous = true;
        continue;
      }
    }

    const matchedLoose =
      resolveActiveFieldKeyInScope(
        childKeys,
        schema.properties,
        childObj,
        breadcrumbPath,
        decofile,
        meta,
      ) != null;
    if (matchedLoose) {
      if (looseMatch === null) looseMatch = key;
      else looseAmbiguous = true;
    }
  }
  if (strongMatch !== null) return strongAmbiguous ? null : strongMatch;
  if (looseMatch !== null) return looseAmbiguous ? null : looseMatch;

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
        meta,
      );
      if (direct) return key;

      if (labelsMatch(head, label) || labelsMatch(head, key)) {
        const viaLabel = resolveActiveFieldKeyInScope(
          branchKeys,
          branchProps,
          childObj,
          breadcrumbPath.slice(1),
          decofile,
          meta,
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
  const valueOwners: string[] = [];
  // Folded array labels on the trail's item crumbs — match the array's name against a loader's field keys when its item label is schema-only (titleBy).
  const foldedArrayLabels = breadcrumbPath
    .map(crumbArrayLabel)
    .filter((l): l is string => l != null);
  for (const key of keys) {
    const schema = properties[key];
    if (schema?.type !== "block-ref") continue;
    // NB: keep the plain label here — this branch disambiguates same-titled
    // block-refs (e.g. two "Section" loaders) by VALUE ownership, so it must
    // still match the shared title crumb, not a key-disambiguated one.
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
      const data = saved?.data ?? rawVal;
      if (
        valueOwnsItemCrumb(data, head) ||
        foldedArrayLabels.some(
          (al) =>
            valueOwnsItemCrumb(data, al) ||
            blockRefSchemaOwnsArrayLabel(data, al, meta),
        )
      ) {
        valueOwners.push(key);
      }
      continue;
    }

    if (breadcrumbPath.length > 1) {
      const val = objValue[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const nextCrumb = crumbLabel(breadcrumbPath[1]!);
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
  // A field the crumb NAMES (head === its label) beats a value-ownership guess.
  if (blockRefFallback) return blockRefFallback;
  // One owner → narrow to it; two or more → ambiguous, so keep every sibling shown.
  if (valueOwners.length === 1) return valueOwners[0]!;
  if (valueOwners.length > 1) return null;

  return null;
}

/** Resolve which top-level property is active for the current breadcrumb trail. */
export function resolveActiveFieldKey(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown>,
  breadcrumbPath: Crumb[],
  decofile?: Record<string, unknown>,
  meta?: LiveMeta,
): string | null {
  return resolveActiveFieldKeyInScope(
    keys,
    properties,
    objValue,
    breadcrumbPath,
    decofile,
    meta,
  );
}

/** True when the breadcrumb trail targets a field inside this object. */
export function isBreadcrumbInsideObject(
  fieldKey: string,
  label: string,
  schema: SchemaProperty,
  objValue: Record<string, unknown>,
  breadcrumbPath: Crumb[],
  decofile?: Record<string, unknown>,
  meta?: LiveMeta,
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
      meta,
    )
  ) {
    return true;
  }

  const head = crumbLabel(breadcrumbPath[0]!);
  if (!labelsMatch(head, label) && !labelsMatch(head, fieldKey)) return false;

  return (
    breadcrumbPath.length > 1 ||
    resolveActiveFieldKeyInScope(
      keys,
      schema.properties,
      objValue,
      breadcrumbPath.slice(1),
      decofile,
      meta,
    ) !== null
  );
}

/**
 * Find the array item a crumb points at.
 *
 * An item crumb carries the item's exact `itemIndex`, so it re-resolves to that
 * item directly — no reliance on a unique display label or on the transient open
 * index (which is wiped on a form remount). The `label` part still does
 * *ownership*: a bare index is valid for any array with ≥2 items, so we confirm
 * this array is the crumb's owner by matching the item's base label before
 * trusting the index. Plain string crumbs (field/array labels) never identify an
 * item, so they return -1.
 *
 * `preferredIndex` (the item the caller currently has open) is only a churn-window
 * fallback: while a label edit is mid-flight it keeps selection pinned to the
 * open row. The exact-index path makes it non-load-bearing.
 */
function findItemIndexForCrumb(
  items: unknown[],
  itemSchema: SchemaProperty | undefined,
  crumb: Crumb,
  preferredIndex?: number | null,
): number {
  if (!isItemCrumb(crumb)) return -1;
  const labels = getArrayItemDisplayLabels(items, itemSchema);
  // Exact pin: the index addresses the item; the label confirms this array owns it.
  if (
    crumb.itemIndex >= 0 &&
    crumb.itemIndex < items.length &&
    labelsMatch(labels[crumb.itemIndex]!, crumb.label)
  ) {
    return crumb.itemIndex;
  }
  /**
   * Open-row pin: the crumb still addresses the row the user has open, but its
   * label lags `items[itemIndex]` mid-edit — e.g. a titleBy driven by a field
   * being typed, or a value edited deep in a nested array whose label re-sync
   * races the nested trail rebuild. The index is the source of truth (the label
   * is display-only), so trust it rather than fall through to the label search
   * below, which would snap to a colliding sibling (the duplicated-item
   * "original").
   */
  if (
    preferredIndex != null &&
    preferredIndex === crumb.itemIndex &&
    preferredIndex >= 0 &&
    preferredIndex < items.length
  ) {
    return preferredIndex;
  }
  // Churn-window fallback: the item shifted but its label still matches the open row.
  const preferred = preferredIndex != null ? labels[preferredIndex] : undefined;
  if (preferred !== undefined && labelsMatch(preferred, crumb.label)) {
    return preferredIndex!;
  }
  // Last resort: the item shifted; match by label (−1 if this array isn't the owner).
  return labels.findIndex((label) => labelsMatch(label, crumb.label));
}

/**
 * Resolve which array item the breadcrumb trail points at.
 *
 * Returns `crumbIndex` — the position of the matched item's own crumb in
 * `breadcrumbPath` — alongside `index` (the item's position in `items`) and
 * `innerPath` (the trail *inside* the item). `crumbIndex` is the single source
 * of truth for "where the open item's label lives in the trail": callers that
 * rewrite that crumb when the label changes (see `ArrayField.updateItem`) MUST
 * use it rather than re-deriving the position by looking up the old label text
 * — a text lookup strands the crumb the moment the label churns (the edited
 * item then re-resolves to a colliding sibling — the "editing a duplicate's
 * title snaps back to the original" bug). Because it comes straight from the
 * crumb this function actually matched, it can never point at a non-item crumb.
 *
 * `innerPath` is always a trailing suffix of `breadcrumbPath` (both return sites
 * slice from `crumbIndex + 1`), so `crumbIndex === length - innerPath.length - 1`
 * — keep it that way if you touch the slicing.
 */
export function resolveArrayItemSelection(
  label: string,
  breadcrumbPath: Crumb[],
  items: unknown[],
  itemSchema: SchemaProperty | undefined,
  preferredIndex?: number | null,
): { index: number; innerPath: Crumb[]; crumbIndex: number } | null {
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
      return { index, innerPath: breadcrumbPath.slice(pi + 1), crumbIndex: pi };
    }
  }

  const labelIndex = breadcrumbPath.findIndex((crumb) =>
    labelsMatch(crumbLabel(crumb), label),
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
      return {
        index,
        innerPath: breadcrumbPath.slice(labelIndex + 2),
        crumbIndex: labelIndex + 1,
      };
    }
  }

  return null;
}
