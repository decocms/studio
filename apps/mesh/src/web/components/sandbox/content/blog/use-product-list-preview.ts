import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { useBlogSandbox } from "./blog-sandbox-context";
import {
  readProductListIds,
  toInvokeLoaderBodies,
} from "./blocks/product-loader-utils";
import {
  alignProductsToIds,
  parseProductListPreview,
  productListLoaderKey,
  type ResolvedProductPreview,
} from "./blocks/product-preview-utils";

async function invokeProductLoader(
  sandbox: { orgSlug: string; virtualMcpId: string; branch: string },
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(
    `/api/${sandbox.orgSlug}/sandbox/${encodeURIComponent(sandbox.virtualMcpId)}/${encodeURIComponent(sandbox.branch)}/preview-invoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to resolve product loader: ${res.status}`);
  }
  const data = await res.json();
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "error" in data &&
    typeof (data as { error?: unknown }).error === "string"
  ) {
    throw new Error((data as { error: string }).error);
  }
  return data;
}

export function useProductListPreview(loader: unknown): {
  products: ResolvedProductPreview[];
  productsById: (ResolvedProductPreview | null)[];
  isLoading: boolean;
  isError: boolean;
} {
  const sandbox = useBlogSandbox();
  const ids = readProductListIds(loader);
  const loaderKey = productListLoaderKey(loader);
  const sandboxKey = sandbox
    ? `${sandbox.orgSlug}/${sandbox.virtualMcpId}/${sandbox.branch}`
    : "";

  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(sandboxKey, loaderKey),
    queryFn: async () => {
      // Ref-array shapes invoke one loader per product; list-loaders invoke
      // once. Results keep body order, so flatMap preserves id positions.
      const bodies = toInvokeLoaderBodies(loader);
      const results = await Promise.all(
        bodies.map((body) => invokeProductLoader(sandbox!, body)),
      );
      return results.flatMap(parseProductListPreview);
    },
    enabled: !!sandbox && ids.some((id) => id.trim()),
    staleTime: 60_000,
    retry: 1,
  });

  const parsed = query.data ?? [];
  return {
    products: parsed.filter(
      (product): product is ResolvedProductPreview => product !== null,
    ),
    productsById: alignProductsToIds(ids, parsed),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
