import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { fillPathTemplate } from "@/web/components/sections-editor/page-path-utils";
import { KEYS } from "@/web/lib/query-keys";
import { useT } from "@/web/i18n/use-t.ts";
import {
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

const PARAM_LABEL_BADGE =
  "rounded-sm bg-violet-500/15 px-1 py-0.5 text-[12px] text-violet-600 dark:text-violet-400";

const KIND_LABELS: Record<PathParamKind, { noun: string; heading: string }> = {
  product: { noun: "product", heading: "Products" },
  category: { noun: "category", heading: "Categories" },
};

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
 * calls (e.g. product ids + name query); they run in parallel and merge in
 * order, deduped. Partial failures are tolerated as long as one call succeeds.
 */
async function fetchOptions(
  ref: RunBlockSandboxRef,
  source: OptionSource,
  term: string,
  ctx: OptionPayloadContext,
): Promise<PathParamOption[]> {
  const requests = source.buildRequests(term);
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

/** One source's fetched options rendered as a labelled command group. */
function PickerSourceGroup({
  source,
  sandboxRef,
  template,
  paramName,
  open,
  search,
  debouncedSearch,
  showHeading,
  onSelect,
}: {
  source: OptionSource;
  sandboxRef: RunBlockSandboxRef;
  template: string;
  paramName: string;
  open: boolean;
  search: string;
  debouncedSearch: string;
  showHeading: boolean;
  onSelect: (value: string) => void;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: pickerInvokeKey(sandboxRef, source, debouncedSearch),
    queryFn: () =>
      fetchOptions(sandboxRef, source, debouncedSearch, {
        template,
        paramName,
      }),
    enabled: open,
    staleTime: 60_000,
    retry: 1,
  });

  const { noun, heading } = KIND_LABELS[source.kind];
  const options = source.clientFilter
    ? filterPickerOptions(query.data ?? [], search)
    : (query.data ?? []);

  const status = query.isLoading
    ? t("sandbox.pathParamPickerChip.loading", { noun })
    : query.isError
      ? t("sandbox.pathParamPickerChip.couldNotLoad")
      : null;

  if (!status && options.length === 0) return null;

  return (
    <CommandGroup heading={showHeading ? heading : undefined}>
      {status ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">{status}</div>
      ) : (
        options.map((opt) => (
          <CommandItem
            key={`${source.id}:${opt.value}`}
            value={`${source.id}:${opt.value}`}
            className="gap-3 py-2"
            onSelect={() => onSelect(opt.value)}
          >
            {source.kind === "product" && (
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
        ))
      )}
    </CommandGroup>
  );
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
  const nouns = [...new Set(sources.map((s) => KIND_LABELS[s.kind].noun))];
  const placeholder = t("sandbox.pathParamPickerChip.searchPlaceholder", {
    options: nouns.join(" or "),
  });

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
  const rawTerm = search.trim().replace(/^\/+|\/+$/g, "");
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
        className={cn(
          PARAM_LABEL_BADGE,
          "max-w-64 shrink-0 cursor-pointer truncate hover:bg-violet-500/25",
        )}
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
              <span className={cn(PARAM_LABEL_BADGE, "font-mono")}>
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
            <CommandList className="max-h-none flex-1">
              <CommandEmpty>
                {t("sandbox.pathParamPickerChip.noResults")}
              </CommandEmpty>
              {rawTerm && (
                <CommandGroup>
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
              {sources.map((source) => (
                <PickerSourceGroup
                  key={source.id}
                  source={source}
                  sandboxRef={sandboxRef}
                  template={template}
                  paramName={paramName}
                  open={open}
                  search={search}
                  debouncedSearch={debouncedSearch}
                  showHeading={sources.length > 1}
                  onSelect={commit}
                />
              ))}
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
 * lands on a real entity instead of an empty page. Mounted by preview.tsx only
 * while the param is empty (unmounts the instant the value is filled), so it
 * never overwrites a user/restored value and can't loop. Shares the chip's
 * react-query cache (same key/fetch).
 */
export function PathParamAutoFill({
  source,
  template,
  paramName,
  sandboxRef,
  onFill,
}: {
  source: OptionSource;
  template: string;
  paramName: string;
  sandboxRef: RunBlockSandboxRef;
  onFill: (value: string) => void;
}) {
  const query = useQuery({
    queryKey: pickerInvokeKey(sandboxRef, source, ""),
    queryFn: () =>
      fetchOptions(sandboxRef, source, "", { template, paramName }),
    staleTime: 60_000,
    retry: 1,
  });
  // Render-time guard (the codebase's run-once pattern). Setting own state
  // during render is allowed; the parent commit is deferred to a microtask so
  // it doesn't update a different component mid-render.
  const [filled, setFilled] = useState(false);
  if (!filled && query.data && query.data.length > 0) {
    setFilled(true);
    const value = query.data[0]!.value;
    queueMicrotask(() => onFill(value));
  }
  return null;
}
