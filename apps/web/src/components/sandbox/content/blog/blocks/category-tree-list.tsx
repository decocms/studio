/**
 * The store's category tree, filtered in the browser.
 *
 * Shared by the product picker (where a category narrows the product results)
 * and the campaign target editor (where a category *is* the answer). Only the
 * list is shared: the product picker wraps it in a breadcrumb that lets you
 * back out of the chosen category, which a target picker has no use for.
 *
 * The tree is term-independent, so it is fetched once and filtered locally —
 * typing never hits the store.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { KEYS } from "@/lib/query-keys";
import { type PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import {
  buildCategoryTreeRequest,
  categoryOptionsFromPayload,
  filterCategoryOptions,
  type CategoryOption,
} from "./product-picker-source";
import { invokeLoader } from "./use-product-lookup";
import { useT } from "@/i18n/use-t.ts";

export function sandboxKey(ref: PreviewProxyRef): string {
  return `${ref.orgSlug}/${ref.virtualMcpId}/${ref.branch}`;
}

/** Status line shared by the results and category panes. */
export function StatusLine({
  query,
  emptyLabel,
  loadingLabel,
}: {
  query: { isLoading: boolean; isError: boolean };
  emptyLabel: string;
  loadingLabel: string;
}) {
  const t = useT();
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
        <Spinner size="xs" />
        {loadingLabel}
      </div>
    );
  }
  if (query.isError) {
    return (
      <p className="px-2 py-6 text-sm text-muted-foreground">
        {t("sandbox.productPickerDialog.couldNotLoad")}
      </p>
    );
  }
  return (
    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
      {emptyLabel}
    </p>
  );
}

export function CategoryTreeList({
  sandboxRef,
  enabled,
  onSelect,
  className,
}: {
  sandboxRef: PreviewProxyRef;
  /** The tree only loads once the surface holding it is actually open. */
  enabled: boolean;
  onSelect: (category: CategoryOption) => void;
  /** Height of the scroll area; the surfaces that hold this differ. */
  className?: string;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(sandboxKey(sandboxRef), "blog-category-tree"),
    queryFn: () =>
      invokeLoader(sandboxRef, buildCategoryTreeRequest()).then(
        categoryOptionsFromPayload,
      ),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });

  const options = filterCategoryOptions(query.data ?? [], filter);

  return (
    <div className="space-y-2">
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t(
          "sandbox.productPickerDialog.filterCategoriesPlaceholder",
        )}
        className="h-9"
      />
      <div className={cn("overflow-y-auto rounded-md border", className)}>
        {options.length === 0 ? (
          <StatusLine
            query={query}
            loadingLabel={t("sandbox.productPickerDialog.loadingCategories")}
            emptyLabel={t("sandbox.productPickerDialog.noCategories")}
          />
        ) : (
          <div className="p-1">
            {options.map((option) => (
              <button
                key={option.path}
                type="button"
                onClick={() => onSelect(option)}
                className="block w-full truncate px-2 py-1.5 text-left text-sm hover:bg-muted/60 rounded-lg"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
