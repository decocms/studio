import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchSm } from "@untitledui/icons";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { KEYS } from "@/web/lib/query-keys";
import {
  categoryOptionsFromPayload,
  filterPickerOptions,
  pickerLoaderRequest,
  productOptionsFromPayload,
  type PathParamOption,
  type PathParamPickerKind,
} from "./path-param-picker";

const PICKER_FETCH_TIMEOUT_MS = 10_000;

/**
 * Invoke the kind's loader straight at the preview origin — same pattern as
 * the sections editor's dynamic-options field. The resolveType goes in the
 * path with slashes intact (that's the shape the deco runtime routes).
 */
async function fetchPickerOptions(
  previewUrl: string,
  kind: PathParamPickerKind,
  term: string,
): Promise<PathParamOption[]> {
  const { resolveType, props } = pickerLoaderRequest(kind, term);
  const base = previewUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/deco/invoke/${resolveType}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(props),
    signal: AbortSignal.timeout(PICKER_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${kind} options: ${res.status}`);
  }
  const data = await res.json();
  return kind === "product"
    ? productOptionsFromPayload(data)
    : categoryOptionsFromPayload(data);
}

/**
 * Search-icon button beside a path-param chip: opens a centered modal listing
 * real store entities (VTEX products for PDP params, categories for the PLP
 * catch-all); picking one commits the param value via `onPick`.
 */
export function PathParamPickerButton({
  kind,
  paramName,
  previewUrl,
  sandboxKey,
  onPick,
}: {
  kind: PathParamPickerKind;
  paramName: string;
  previewUrl: string;
  sandboxKey: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSearch("");
      setDebouncedSearch("");
    }
  };

  const handleSearchChange = (next: string) => {
    setSearch(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(next);
    }, 300);
  };

  // The category tree is term-independent (fetched once, filtered locally),
  // so its query key ignores the search term.
  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(
      sandboxKey,
      `path-param-${kind}:${kind === "product" ? debouncedSearch : ""}`,
    ),
    queryFn: () => fetchPickerOptions(previewUrl, kind, debouncedSearch),
    enabled: open,
    staleTime: 60_000,
    retry: 1,
  });

  const options =
    kind === "product"
      ? (query.data ?? [])
      : filterPickerOptions(query.data ?? [], search);

  const noun = kind === "product" ? "product" : "category";
  const paramLabel = paramName === "*" ? "*" : `:${paramName}`;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* The URL-bar container toggles the pages dropdown on click, so
              the trigger must not let clicks bubble. */}
          <button
            type="button"
            aria-label={`Pick a ${noun} for ${paramLabel}`}
            className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
          >
            <SearchSm size={11} />
          </button>
        </TooltipTrigger>
        <TooltipContent>Pick a {noun}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:h-[520px] sm:max-w-[560px]">
          <DialogHeader className="sr-only">
            <DialogTitle>Pick a {noun}</DialogTitle>
          </DialogHeader>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
            <SearchSm size={16} className="shrink-0 text-foreground" />
            <span className="text-sm font-medium text-foreground">
              Pick a {noun} for{" "}
              <span className="rounded-sm bg-violet-500/15 px-1 py-0.5 font-mono text-[12px] text-violet-600 dark:text-violet-400">
                {paramLabel}
              </span>
            </span>
          </div>
          <Command shouldFilter={false} className="min-h-0 flex-1">
            <CommandInput
              autoFocus
              placeholder={
                kind === "product"
                  ? "Search products..."
                  : "Search categories..."
              }
              value={search}
              onValueChange={handleSearchChange}
            />
            <CommandList className="max-h-none flex-1">
              <CommandEmpty>
                {query.isLoading
                  ? "Loading..."
                  : query.isError
                    ? "Couldn't load — is the dev server running?"
                    : "No results."}
              </CommandEmpty>
              <CommandGroup>
                {options.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    className="gap-3 py-2"
                    onSelect={() => {
                      onPick(opt.value);
                      handleOpenChange(false);
                    }}
                  >
                    {kind === "product" && (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                        {opt.image ? (
                          <img
                            src={opt.image}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <SearchSm
                            size={14}
                            className="text-muted-foreground"
                          />
                        )}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {opt.label}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        /{kind === "product" ? `${opt.value}/p` : opt.value}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
