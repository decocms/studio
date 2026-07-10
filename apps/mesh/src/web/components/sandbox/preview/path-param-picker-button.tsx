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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
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
 * Search-icon button beside a path-param chip: opens a popover listing real
 * store entities (VTEX products for PDP params, categories for the PLP
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* The URL-bar container toggles the pages dropdown on click, so
                the trigger (and popover content) must not let clicks bubble. */}
            <button
              type="button"
              aria-label={`Pick a ${noun} for ${paramLabel}`}
              className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <SearchSm size={11} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Pick a {noun}</TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-72 p-0"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={
              kind === "product" ? "Search products..." : "Search categories..."
            }
            className="h-9"
            value={search}
            onValueChange={handleSearchChange}
          />
          <CommandList>
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
                  onSelect={() => {
                    onPick(opt.value);
                    setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {opt.image && (
                      <img
                        src={opt.image}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-8 w-8 shrink-0 rounded object-cover"
                      />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate">{opt.label}</span>
                      {kind === "category" && opt.value !== opt.label && (
                        <span className="block truncate text-xs text-muted-foreground">
                          /{opt.value}
                        </span>
                      )}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
