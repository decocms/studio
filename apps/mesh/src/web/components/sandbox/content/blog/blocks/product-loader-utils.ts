const DEFAULT_VTEX_PRODUCT_LIST =
  "vtex/loaders/intelligentSearch/productList.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read VTEX productList loader ids from a block-ref value. */
export function readProductListIds(loader: unknown): string[] {
  const props = asRecord(asRecord(loader)?.props);
  if (!props || !Array.isArray(props.ids)) return [];
  return props.ids
    .map((id) =>
      typeof id === "string" || typeof id === "number" ? String(id) : "",
    )
    .filter(Boolean);
}

/** Build the preview-invoke payload for a VTEX productList block-ref. */
export function toInvokeLoaderBody(loader: unknown): Record<string, unknown> {
  const existing = asRecord(loader) ?? {};
  const resolveType = readProductListResolveType(loader);
  const props = asRecord(existing.props) ?? {};
  const ids = readProductListIds(loader);

  const loaderProps: Record<string, unknown> = { ids };

  if (typeof props.hideUnavailableItems === "boolean") {
    loaderProps.hideUnavailableItems = props.hideUnavailableItems;
  }

  return {
    __resolveType: resolveType,
    props: loaderProps,
  };
}

/** Resolve type for a productList block-ref. */
export function readProductListResolveType(loader: unknown): string {
  const existing = asRecord(loader) ?? {};
  return typeof existing.__resolveType === "string"
    ? existing.__resolveType
    : DEFAULT_VTEX_PRODUCT_LIST;
}

/** Update ids on a VTEX productList loader, preserving resolveType and props. */
export function writeProductListIds(
  loader: unknown,
  ids: string[],
): Record<string, unknown> {
  const existing = asRecord(loader) ?? {};
  const props = asRecord(existing.props) ?? {};
  const resolveType = readProductListResolveType(loader);

  return {
    ...existing,
    __resolveType: resolveType,
    props: {
      ...props,
      ids,
      simulationBehavior: props.simulationBehavior ?? "default",
    },
  };
}
