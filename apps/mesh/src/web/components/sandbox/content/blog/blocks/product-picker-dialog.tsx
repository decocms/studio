import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, SearchSm } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { KEYS } from "@/web/lib/query-keys";
import { type RunBlockSandboxRef } from "@/web/components/sandbox/content/use-run-block";
import {
  buildCategoryTreeRequest,
  buildProductRequests,
  categoryOptionsFromPayload,
  filterCategoryOptions,
  productOptionsFromPayload,
  type CategoryOption,
  type PickerLoaderRequest,
  type ProductPickerMode,
  type ProductPickerOption,
} from "./product-picker-source";
import { invokeLoader } from "./use-product-lookup";
import { useT } from "@/web/i18n/use-t.ts";
import type { TranslationKey } from "@/web/i18n/en/index.ts";

const MODES = [
  { id: "search", labelKey: "sandbox.productPickerDialog.modeSearch" },
  { id: "category", labelKey: "sandbox.productPickerDialog.modeCategory" },
  { id: "cluster", labelKey: "sandbox.productPickerDialog.modeClusterId" },
] as const satisfies { id: ProductPickerMode; labelKey: TranslationKey }[];

/**
 * Fetch products for the current mode+term. A term can fan out to several
 * loader calls (numeric search tries ids + name query); they run in parallel
 * and merge in order, deduped by id. Tolerates partial failure as long as one
 * call succeeds.
 */
async function fetchProducts(
  ref: RunBlockSandboxRef,
  requests: PickerLoaderRequest[],
): Promise<ProductPickerOption[]> {
  if (requests.length === 0) return [];
  const settled = await Promise.allSettled(
    requests.map((request) => invokeLoader(ref, request)),
  );
  const payloads = settled
    .filter(
      (s): s is PromiseFulfilledResult<unknown> => s.status === "fulfilled",
    )
    .map((s) => s.value);
  if (payloads.length === 0) {
    const failed = settled.find(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    throw failed ? failed.reason : new Error("Failed to fetch products");
  }
  const merged: ProductPickerOption[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    for (const option of productOptionsFromPayload(payload)) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      merged.push(option);
    }
  }
  return merged;
}

/**
 * A text field whose committed value trails typing by `delay`. Debounces in
 * the change handler (never during render), so it plays well with the React
 * compiler — the same approach the preview path-param picker uses.
 */
function useDebouncedField(delay: number) {
  const [value, setValue] = useState("");
  const [debounced, setDebounced] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = (next: string) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(next), delay);
  };
  return { value, debounced, onChange };
}

/** A single product row — click toggles it in/out of the selection. */
function ProductRow({
  option,
  selected,
  onToggle,
}: {
  option: ProductPickerOption;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-2 py-2 text-left transition-colors",
        selected
          ? "border-primary/40 bg-primary/5"
          : "border-transparent hover:bg-muted/60",
      )}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
        {option.image ? (
          <img
            src={option.image}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <SearchSm size={14} className="text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm">{option.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          ID {option.id}
        </span>
      </span>
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border text-transparent",
        )}
      >
        <Check size={12} />
      </span>
    </button>
  );
}

/** Status line shared by the results and category panes. */
function StatusLine({
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

function sandboxKey(ref: RunBlockSandboxRef): string {
  return `${ref.orgSlug}/${ref.virtualMcpId}/${ref.branch}`;
}

/** The category picker pane — pick one to filter products by it. */
function CategoryPane({
  sandboxRef,
  open,
  selected,
  onSelect,
}: {
  sandboxRef: RunBlockSandboxRef;
  open: boolean;
  selected: CategoryOption | null;
  onSelect: (category: CategoryOption | null) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(sandboxKey(sandboxRef), "blog-category-tree"),
    queryFn: () =>
      invokeLoader(sandboxRef, buildCategoryTreeRequest()).then(
        categoryOptionsFromPayload,
      ),
    enabled: open && !selected,
    staleTime: 60_000,
    retry: 1,
  });

  if (selected) {
    return (
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <ChevronLeft size={14} />
        <span className="truncate">
          {t("sandbox.productPickerDialog.categoryLabel")}
          <span className="text-foreground">{selected.label}</span> —
          {t("sandbox.productPickerDialog.change")}
        </span>
      </button>
    );
  }

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
      <div className="h-48 overflow-y-auto rounded-md border">
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
                className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60"
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

/**
 * Multi-select product picker for the blog ProductShelf/ProductCard blocks.
 * Browse by free search, category, or collection/cluster id (all VTEX
 * intelligent-search); toggling a product adds/removes its SKU id from
 * `selectedIds`. The picker only surfaces ids — the section still resolves
 * them to `Product[]`.
 */
export function ProductPickerDialog({
  open,
  onOpenChange,
  sandboxRef,
  selectedIds,
  onChange,
  multiple = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxRef: RunBlockSandboxRef;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Product card selects a single product; shelf selects many. */
  multiple?: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState<ProductPickerMode>("search");
  const search = useDebouncedField(300);
  const cluster = useDebouncedField(300);
  const [category, setCategory] = useState<CategoryOption | null>(null);

  const term =
    mode === "search"
      ? search.debounced
      : mode === "cluster"
        ? cluster.debounced
        : (category?.path ?? "");
  const requests = buildProductRequests(mode, term);

  const productsQuery = useQuery({
    queryKey: KEYS.sandboxInvoke(
      sandboxKey(sandboxRef),
      `blog-product:${mode}:${term}`,
    ),
    queryFn: () => fetchProducts(sandboxRef, requests),
    enabled: open && requests.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const selected = new Set(selectedIds.filter(Boolean));

  const toggle = (id: string) => {
    if (!multiple) {
      onChange(selected.has(id) ? [] : [id]);
      return;
    }
    if (selected.has(id)) {
      onChange(selectedIds.filter((existing) => existing !== id));
    } else {
      onChange([...selectedIds.filter(Boolean), id]);
    }
  };

  const products = productsQuery.data ?? [];
  const showEmptyPrompt = requests.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:h-[560px] sm:max-w-[560px]">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            {multiple
              ? t("sandbox.productPickerDialog.addProducts")
              : t("sandbox.productPickerDialog.chooseProduct")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm transition-colors",
                mode === m.id
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>

        <div className="shrink-0 space-y-2 px-4 py-3">
          {mode === "search" && (
            <Input
              autoFocus
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={t(
                "sandbox.productPickerDialog.searchProductsPlaceholder",
              )}
              className="h-9"
            />
          )}
          {mode === "cluster" && (
            <Input
              autoFocus
              value={cluster.value}
              onChange={(e) => cluster.onChange(e.target.value)}
              placeholder={t(
                "sandbox.productPickerDialog.clusterIdPlaceholder",
              )}
              className="h-9"
            />
          )}
          {mode === "category" && (
            <CategoryPane
              sandboxRef={sandboxRef}
              open={open}
              selected={category}
              onSelect={setCategory}
            />
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-border px-3 py-2">
          {products.length > 0
            ? products.map((option) => (
                <ProductRow
                  key={option.id}
                  option={option}
                  selected={selected.has(option.id)}
                  onToggle={() => toggle(option.id)}
                />
              ))
            : !showEmptyPrompt && (
                <StatusLine
                  query={productsQuery}
                  loadingLabel={t(
                    "sandbox.productPickerDialog.loadingProducts",
                  )}
                  emptyLabel={t("sandbox.productPickerDialog.noProductsFound")}
                />
              )}
          {showEmptyPrompt && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {mode === "category"
                ? t("sandbox.productPickerDialog.pickCategoryPrompt")
                : mode === "cluster"
                  ? t("sandbox.productPickerDialog.enterClusterPrompt")
                  : t("sandbox.productPickerDialog.typeToSearchPrompt")}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {selected.size === 0
              ? t("sandbox.productPickerDialog.noneSelected")
              : t("sandbox.productPickerDialog.selectedCount", {
                  count: String(selected.size),
                })}
          </span>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("sandbox.productPickerDialog.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
