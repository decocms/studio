import { Fragment, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowRight, SearchSm } from "@untitledui/icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  fillPathTemplate,
  stripSurroundingSlashes,
} from "@/web/components/sections-editor/page-path-utils";
import { KEYS } from "@/web/lib/query-keys";
import { useT } from "@/web/i18n/use-t.ts";
import {
  buildPreviewFetchPath,
  buildPreviewInvokePath,
  type RunBlockSandboxRef,
} from "@/web/components/sandbox/content/use-run-block";
import {
  filterPickerOptions,
  mergePickerOptions,
  type OptionPayloadContext,
  type OptionSource,
  type PathParamKind,
  type PathParamOption,
  type PickerLoaderRequest,
} from "./path-param-picker";

const PICKER_FETCH_TIMEOUT_MS = 10_000;

function kindLabels(
  t: ReturnType<typeof useT>,
): Record<PathParamKind, { noun: string; heading: string }> {
  return {
    product: {
      noun: t("sandbox.pathParamPickerChip.kindProductNoun"),
      heading: t("sandbox.pathParamPickerChip.kindProductHeading"),
    },
    category: {
      noun: t("sandbox.pathParamPickerChip.kindCategoryNoun"),
      heading: t("sandbox.pathParamPickerChip.kindCategoryHeading"),
    },
  };
}

/**
 * Invoke a loader via the studio preview-invoke proxy (same-origin,
 * authenticated) — the same route useRunBlock uses. Fetching the preview
 * origin directly would hit CORS: previews don't send
 * `Access-Control-Allow-Origin` for `/deco/invoke`.
 */
async function invokeLoader(
  ref: RunBlockSandboxRef,
  { resolveType, props }: PickerLoaderRequest,
): Promise<unknown> {
  const res = await fetch(buildPreviewInvokePath(ref), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ __resolveType: resolveType, ...props }),
    signal: AbortSignal.timeout(PICKER_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch options: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch a storefront page's SSR HTML through the preview-fetch proxy
 * (same-origin, server-side — the preview origin isn't CORS-reachable). Used by
 * the homepage-links fallback source to discover real category/product URLs.
 */
async function fetchPreviewPage(
  ref: RunBlockSandboxRef,
  path: string,
): Promise<string> {
  const res = await fetch(buildPreviewFetchPath(ref, path), {
    signal: AbortSignal.timeout(PICKER_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch page: ${res.status}`);
  }
  return res.text();
}

/**
 * Discover options for the homepage-links source. The homepage yields the nav
 * categories, but its (cookie-less) SSR often omits shelf products — so we drill
 * into the first discovered listing, whose SSR embeds the product JSON, and
 * merge. Two fetches at most; a failed drill-in still returns the categories.
 */
async function fetchSiteLinkOptions(
  ref: RunBlockSandboxRef,
  source: OptionSource,
  ctx: OptionPayloadContext,
): Promise<PathParamOption[]> {
  const home = source.optionsFromPayload(await fetchPreviewPage(ref, "/"), ctx);
  // Drill into the first CATEGORY (a listing page whose SSR embeds shelf
  // products) — not home[0], which is a product when the homepage embeds shelves
  // (products are emitted before categories), and a PDP has no shelf to scrape.
  const firstListing = home.find((o) => o.kind === "category");
  if (!firstListing) return home;
  const listingPath = fillPathTemplate(ctx.template, {
    [ctx.paramName]: firstListing.value,
  });
  if (listingPath === "/") return home;
  try {
    // The listing page contributes PRODUCTS only — categories stay the clean
    // homepage nav, not the drilled page's (much longer) subcategory list.
    const products = source
      .optionsFromPayload(await fetchPreviewPage(ref, listingPath), ctx)
      .filter((o) => o.kind === "product");
    return mergePickerOptions([home, products]);
  } catch {
    return home;
  }
}

/**
 * react-query key for a source + term. clientFilter sources fetch once (whole
 * tree, filtered locally) so their key ignores the term; both the chip's modal
 * query and preview.tsx's auto-fill query use this, sharing one cache entry.
 */
function pickerInvokeKey(
  ref: RunBlockSandboxRef,
  source: OptionSource,
  term: string,
) {
  return KEYS.sandboxInvoke(
    `${ref.orgSlug}/${ref.virtualMcpId}/${ref.branch}`,
    `path-param-${source.id}:${source.clientFilter ? "" : term}`,
  );
}

/**
 * Fetch and map options for one source. A term can fan out to several loader
 * calls (e.g. product ids + name query, or the generic-seed variants); they run
 * in parallel and merge in order, deduped. Partial failures are tolerated as
 * long as one call succeeds.
 */
async function fetchOptions(
  ref: RunBlockSandboxRef,
  source: OptionSource,
  term: string,
  ctx: OptionPayloadContext,
): Promise<PathParamOption[]> {
  if (source.homepageLinks) {
    return fetchSiteLinkOptions(ref, source, ctx);
  }
  const requests = source.buildRequests?.(term) ?? [];
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
    throw failed ? failed.reason : new Error("Failed to fetch options");
  }
  return mergePickerOptions(
    payloads.map((payload) => source.optionsFromPayload(payload, ctx)),
  );
}

/** query options shared by the chip's modal and the headless auto-fill. */
function pickerQuery(
  ref: RunBlockSandboxRef,
  source: OptionSource,
  term: string,
  ctx: OptionPayloadContext,
  enabled: boolean,
) {
  return {
    queryKey: pickerInvokeKey(ref, source, term),
    queryFn: () => fetchOptions(ref, source, term, ctx),
    enabled,
    staleTime: 60_000,
    retry: 1,
  };
}

/** A labelled list of options (presentational). Renders nothing when empty. */
function OptionGroup({
  heading,
  iconKind,
  options,
  template,
  paramName,
  keyPrefix,
  onSelect,
}: {
  heading?: string;
  iconKind: PathParamKind;
  options: PathParamOption[];
  template: string;
  paramName: string;
  keyPrefix: string;
  onSelect: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {options.map((opt) => (
        <CommandItem
          key={`${keyPrefix}:${opt.value}`}
          value={`${keyPrefix}:${opt.value}`}
          className="gap-3 py-2"
          onSelect={() => onSelect(opt.value)}
        >
          {iconKind === "product" && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
              {opt.image ? (
                <img
                  src={opt.image}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                <SearchSm size={14} className="text-muted-foreground" />
              )}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{opt.label}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {fillPathTemplate(template, { [paramName]: opt.value })}
            </span>
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Loading / error status line for a source's query. */
function StatusRow({ text }: { text: string }) {
  return <div className="px-2 py-2 text-xs text-muted-foreground">{text}</div>;
}

/**
 * Path-param chip whose click opens a centered picker modal: search real store
 * entities (products / categories, driven by whatever loaders the running site
 * ships) or commit the typed text as a free-form value. Replaces the inline
 * input for params that have at least one option source; committing goes
 * through `onCommit`, the same flow free typing uses elsewhere.
 */
export function PathParamPickerChip({
  sources,
  template,
  paramName,
  value,
  sandboxRef,
  onCommit,
}: {
  sources: OptionSource[];
  template: string;
  paramName: string;
  value: string;
  sandboxRef: RunBlockSandboxRef;
  onCommit: (value: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The `*` catch-all reads badly in the URL bar; show a friendly word instead.
  const paramLabel = paramName === "*" ? "path" : `:${paramName}`;
  const labels = kindLabels(t);
  const nouns = [...new Set(sources.map((s) => labels[s.kind].noun))];
  const placeholder = t("sandbox.pathParamPickerChip.searchPlaceholder", {
    options: nouns.join(" or "),
  });

  const ctx: OptionPayloadContext = { template, paramName };
  const toState = (
    source: OptionSource,
    query: { data?: PathParamOption[]; isLoading: boolean; isError: boolean },
  ) => ({
    source,
    query,
    options: source.clientFilter
      ? filterPickerOptions(query.data ?? [], search)
      : (query.data ?? []),
  });

  // Primaries are queried on open; fallbacks (the homepage-links source) are
  // only queried once the primaries have settled with no options — so opening
  // the picker on a healthy loader-backed page never fires the homepage fetch.
  const primarySources = sources.filter((s) => !s.isFallback);
  const fallbackSources = sources.filter((s) => s.isFallback);
  const primaryQueries = useQueries({
    queries: primarySources.map((source) =>
      pickerQuery(sandboxRef, source, debouncedSearch, ctx, open),
    ),
  });
  const primaryStates = primarySources.map((source, i) =>
    toState(source, primaryQueries[i]!),
  );
  const primariesExhausted =
    primaryStates.length === 0 ||
    primaryStates.every(
      (s) => !s.query.isLoading && (s.query.isError || s.options.length === 0),
    );
  const fallbackQueries = useQueries({
    queries: fallbackSources.map((source) =>
      pickerQuery(
        sandboxRef,
        source,
        debouncedSearch,
        ctx,
        open && primariesExhausted,
      ),
    ),
  });
  const fallbackStates = fallbackSources.map((source, i) =>
    toState(source, fallbackQueries[i]!),
  );

  // Fallbacks REPLACE the primaries once every primary has settled with no
  // options (or there are none) — a loader's "couldn't load" / empty result
  // quietly gives way to the fallback instead of rendering alongside it.
  const visible = primariesExhausted ? fallbackStates : primaryStates;

  // The homepage-links source carries both categories and products. When it's
  // the sole view and both are present, lay them out side by side (Categorias |
  // Produtos); otherwise fall back to the stacked single-column rendering.
  const siteState =
    visible.length === 1 && visible[0]?.source.homepageLinks
      ? visible[0]
      : null;
  const siteReady =
    siteState && !siteState.query.isLoading && !siteState.query.isError;
  const siteData = siteReady ? (siteState?.query.data ?? []) : [];
  const siteCats = filterPickerOptions(
    siteData.filter((o) => o.kind !== "product"),
    search,
  );
  const siteProds = filterPickerOptions(
    siteData.filter((o) => o.kind === "product"),
    search,
  );
  const twoColumn = siteCats.length > 0 && siteProds.length > 0;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Opening seeds the search with the current value so editing an existing
    // value is one click; closing resets so a reopen starts clean.
    setSearch(next ? value : "");
    setDebouncedSearch(next ? value : "");
  };

  const handleSearchChange = (next: string) => {
    setSearch(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(next);
    }, 300);
  };

  const commit = (next: string) => {
    onCommit(next);
    handleOpenChange(false);
  };

  // Strip surrounding slashes so a typed `/sabonetes/x` fills as `sabonetes/x`
  // (the template supplies the leading slash; a `*` value keeps inner slashes).
  const rawTerm = stripSurroundingSlashes(search);
  const rawPath = fillPathTemplate(template, { [paramName]: rawTerm });

  return (
    <>
      {/* The URL-bar container toggles the pages dropdown on click, so the
          chip must not let clicks bubble. */}
      <button
        type="button"
        title={t("sandbox.pathParamPickerChip.buttonTitle", {
          paramLabel,
        })}
        className="max-w-64 shrink-0 cursor-pointer truncate rounded-sm bg-violet-500/15 px-1 py-0.5 text-[12px] text-violet-600 hover:bg-violet-500/25 dark:text-violet-400"
        onClick={(e) => {
          e.stopPropagation();
          handleOpenChange(true);
        }}
      >
        {value || paramLabel}
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:h-[520px] sm:max-w-[560px]"
          // The dialog portals to <body>, but React synthetic events still
          // bubble through the COMPONENT tree — up to the URL-bar container,
          // whose click toggles the pages dropdown. Keep clicks inside.
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {t("sandbox.pathParamPickerChip.pickValueTitle", {
                paramLabel,
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
            <SearchSm size={16} className="shrink-0 text-foreground" />
            <span className="text-sm font-medium text-foreground">
              {t("sandbox.pathParamPickerChip.pickValueHeading")}{" "}
              <span className="rounded-sm bg-violet-500/15 px-1 py-0.5 font-mono text-[12px] text-violet-600 dark:text-violet-400">
                {paramLabel}
              </span>
            </span>
          </div>
          <Command shouldFilter={false} className="min-h-0 flex-1">
            <CommandInput
              autoFocus
              placeholder={placeholder}
              value={search}
              onValueChange={handleSearchChange}
            />
            <CommandList className="flex max-h-none min-h-0 flex-1 flex-col overflow-hidden">
              <CommandEmpty>
                {t("sandbox.pathParamPickerChip.noResults")}
              </CommandEmpty>
              {rawTerm && (
                <CommandGroup className="shrink-0">
                  <CommandItem
                    value={`__raw__:${rawTerm}`}
                    className="gap-3 py-2"
                    onSelect={() => commit(rawTerm)}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted">
                      <ArrowRight size={14} className="text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {t("sandbox.pathParamPickerChip.useRawValue", {
                          rawTerm,
                          paramLabel,
                        })}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {rawPath}
                      </span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
              {twoColumn ? (
                // Categories | Products, side by side, each scrolling on its own.
                <div className="flex min-h-0 flex-1">
                  <div className="min-w-0 flex-1 overflow-y-auto border-r border-border">
                    <OptionGroup
                      heading={labels.category.heading}
                      iconKind="category"
                      options={siteCats}
                      template={template}
                      paramName={paramName}
                      keyPrefix={`${siteState?.source.id}:cat`}
                      onSelect={commit}
                    />
                  </div>
                  <div className="min-w-0 flex-1 overflow-y-auto">
                    <OptionGroup
                      heading={labels.product.heading}
                      iconKind="product"
                      options={siteProds}
                      template={template}
                      paramName={paramName}
                      keyPrefix={`${siteState?.source.id}:prod`}
                      onSelect={commit}
                    />
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {visible.map(({ source, query, options }) => {
                    const { noun } = labels[source.kind];
                    if (query.isLoading)
                      return (
                        <StatusRow
                          key={source.id}
                          text={t("sandbox.pathParamPickerChip.loading", {
                            noun,
                          })}
                        />
                      );
                    if (query.isError)
                      return (
                        <StatusRow
                          key={source.id}
                          text={t("sandbox.pathParamPickerChip.couldNotLoad")}
                        />
                      );
                    // Homepage-links source with only one kind present: render
                    // the non-empty group single-column (two-column handled above).
                    if (source.homepageLinks) {
                      const all = query.data ?? [];
                      return (
                        <Fragment key={source.id}>
                          <OptionGroup
                            heading={labels.category.heading}
                            iconKind="category"
                            options={filterPickerOptions(
                              all.filter((o) => o.kind !== "product"),
                              search,
                            )}
                            template={template}
                            paramName={paramName}
                            keyPrefix={`${source.id}:cat`}
                            onSelect={commit}
                          />
                          <OptionGroup
                            heading={labels.product.heading}
                            iconKind="product"
                            options={filterPickerOptions(
                              all.filter((o) => o.kind === "product"),
                              search,
                            )}
                            template={template}
                            paramName={paramName}
                            keyPrefix={`${source.id}:prod`}
                            onSelect={commit}
                          />
                        </Fragment>
                      );
                    }
                    return (
                      <OptionGroup
                        key={source.id}
                        heading={
                          visible.length > 1
                            ? labels[source.kind].heading
                            : undefined
                        }
                        iconKind={source.kind}
                        options={options}
                        template={template}
                        paramName={paramName}
                        keyPrefix={source.id}
                        onSelect={commit}
                      />
                    );
                  })}
                </div>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Renders nothing; fetches the first option for a picker param that has no
 * value yet and commits it, so navigating to a bare dynamic-route template
 * lands on a real entity instead of an empty page. Tries the ordered sources
 * in priority order (waiting for a higher-priority source before falling to a
 * lower one), so a failing category tree gives way to product search. Mounted
 * by preview.tsx only while the param is empty (unmounts the instant the value
 * is filled), so it never overwrites a user/restored value and can't loop.
 * Shares the chip's react-query cache (same key/fetch).
 */
export function PathParamAutoFill({
  sources,
  template,
  paramName,
  sandboxRef,
  onFill,
}: {
  sources: OptionSource[];
  template: string;
  paramName: string;
  sandboxRef: RunBlockSandboxRef;
  onFill: (value: string) => void;
}) {
  const ctx: OptionPayloadContext = { template, paramName };
  // Only PRIMARY sources auto-fill: a fallback (e.g. product search standing in
  // for a category param) must never silently commit — that would drop a product
  // slug into a Category param and land on the wrong page. A fallback only
  // surfaces when the user opens the modal and the primaries came up empty.
  const primarySources = sources.filter((source) => !source.isFallback);
  const queries = useQueries({
    queries: primarySources.map((source) =>
      pickerQuery(sandboxRef, source, "", ctx, true),
    ),
  });
  // Render-time guard (the codebase's run-once pattern). Setting own state
  // during render is allowed; the parent commit is deferred to a microtask so
  // it doesn't update a different component mid-render.
  const [filled, setFilled] = useState(false);
  if (!filled) {
    for (const query of queries) {
      if (query.isLoading) break; // wait for a higher-priority source
      const first = query.data?.[0];
      if (first) {
        setFilled(true);
        queueMicrotask(() => onFill(first.value));
        break;
      }
    }
  }
  return null;
}
