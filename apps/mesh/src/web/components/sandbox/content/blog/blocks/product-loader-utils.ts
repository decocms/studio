const DEFAULT_VTEX_PRODUCT_LIST =
  "vtex/loaders/intelligentSearch/productList.ts";

/**
 * Product block-refs come in three shapes, depending on who authored the
 * decofile:
 *
 * - **list-loader**: a single loader returning many products —
 *   `{ __resolveType: ".../productList.ts", props: { ids: [...] } }`
 *   (deco-cms/blog app blocks backed by the VTEX intelligentSearch loader).
 * - **ref-array**: one loader ref per product —
 *   `[{ __resolveType: ".../productById.ts", productId: "123" }, ...]`
 *   (site-defined blog sections, e.g. agent-generated storefronts).
 * - **single-ref**: one loader ref for one product —
 *   `{ __resolveType: ".../productById.ts", productId: "123" }`.
 *
 * All helpers here accept any of the three and preserve the stored shape on
 * write, so the editor never rewrites a site's loader wiring.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

/** True for a per-product loader ref (`{ __resolveType, productId }`). */
function isProductRef(value: unknown): value is Record<string, unknown> {
  const rec = asRecord(value);
  return !!rec && typeof rec.__resolveType === "string" && "productId" in rec;
}

/**
 * Read product ids from a block-ref value. Empty entries are preserved so
 * the editor can render a just-added, not-yet-typed row.
 */
export function readProductListIds(loader: unknown): string[] {
  if (Array.isArray(loader)) {
    return loader.map((item) => idString(asRecord(item)?.productId));
  }
  const existing = asRecord(loader);
  const props = asRecord(existing?.props);
  if (props && Array.isArray(props.ids)) {
    return props.ids.map(idString);
  }
  if (existing && "productId" in existing) {
    return [idString(existing.productId)];
  }
  return [];
}

/** Resolve type for a productList block-ref. */
function readProductListResolveType(loader: unknown): string {
  const existing = asRecord(loader) ?? {};
  return typeof existing.__resolveType === "string"
    ? existing.__resolveType
    : DEFAULT_VTEX_PRODUCT_LIST;
}

/**
 * Update ids on a product block-ref, preserving its stored shape: ref-arrays
 * stay ref-arrays (reusing each slot's loader ref), single-refs keep their
 * loader, and list-loaders keep resolveType and props. An empty/unrecognized
 * value falls back to the default VTEX list-loader.
 */
export function writeProductListIds(
  loader: unknown,
  ids: string[],
): Record<string, unknown> | Record<string, unknown>[] {
  if (Array.isArray(loader)) {
    const template = loader.find(isProductRef);
    if (template) {
      return ids.map((id, index) => {
        const slot = asRecord(loader[index]);
        return {
          ...(isProductRef(slot)
            ? slot
            : { __resolveType: template.__resolveType }),
          productId: id,
        };
      });
    }
    // Empty/unrecognized array carries no loader to clone — fall through to
    // the default list-loader shape below.
  }

  const existing = asRecord(loader);
  if (isProductRef(existing) && !asRecord(existing.props)?.ids) {
    return { ...existing, productId: ids[0] ?? "" };
  }

  const props = asRecord(existing?.props) ?? {};
  const resolveType = readProductListResolveType(loader);

  return {
    ...(existing ?? {}),
    __resolveType: resolveType,
    props: {
      ...props,
      ids,
      simulationBehavior: props.simulationBehavior ?? "default",
    },
  };
}
