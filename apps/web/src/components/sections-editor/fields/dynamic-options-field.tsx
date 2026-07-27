import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronSelectorVertical } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
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
import { cn } from "@deco/ui/lib/utils.ts";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import type { FieldProps } from "./field-props";
import { buildPreviewFetchUrl } from "../preview-fetch-url";
import { fetchSpriteIcons } from "./icon-sprite";

export interface DynamicOption {
  value: string;
  label?: string;
  image?: string;
  /** Inline SVG markup for the option preview (deco `icon-select` loaders). */
  icon?: string;
  /**
   * Pre-rendered preview `src` (URL or data-URI). Set by callers that can encode
   * it once up front (e.g. sprite icons) so the render path doesn't re-encode
   * per option; falls back to deriving from `image`/`icon` when absent.
   */
  previewSrc?: string;
}

export function normalizeOptions(data: unknown): DynamicOption[] {
  if (!Array.isArray(data)) return [];
  const result: DynamicOption[] = [];
  for (const item of data) {
    if (typeof item === "string") {
      result.push({ value: item, label: item });
    } else if (item && typeof item === "object" && "value" in item) {
      const obj = item as Record<string, unknown>;
      result.push({
        value: String(obj.value),
        label: typeof obj.label === "string" ? obj.label : String(obj.value),
        image: typeof obj.image === "string" ? obj.image : undefined,
        icon: typeof obj.icon === "string" ? obj.icon : undefined,
      });
    }
  }
  return result;
}

/**
 * Options derived from the schema's own `enum` (icon-name literals). Used as a
 * fallback when the `@options` loader yields nothing — e.g. a deco `icon-select`
 * field whose options loader (`availableIcons.ts`) was dropped during the
 * TanStack migration, so `/deco/invoke/<loader>` 404s. Without this the combobox
 * would render empty; with it the field degrades to the pre-#5080 text list.
 */
export function enumFallbackOptions(
  enumValues: unknown[] | undefined,
): DynamicOption[] {
  if (!Array.isArray(enumValues)) return [];
  const result: DynamicOption[] = [];
  for (const item of enumValues) {
    if (typeof item === "string") result.push({ value: item, label: item });
  }
  return result;
}

/**
 * Pick the option source: loader results when it returned any, otherwise the
 * schema-enum fallback. Loader options carry icon/image previews; the fallback
 * is plain text — so a working loader always wins.
 */
export function resolveOptions(
  loaderOptions: DynamicOption[],
  fallback: DynamicOption[],
): DynamicOption[] {
  return loaderOptions.length > 0 ? loaderOptions : fallback;
}

/**
 * Client-side narrowing of the fetched options. The loader already receives
 * the search as `term`, but many real-world options loaders ignore it and
 * always return the full list (e.g. odin-ui's icons loader) — without this
 * the combobox search would do nothing.
 */
export function filterOptions(
  options: DynamicOption[],
  search: string,
): DynamicOption[] {
  const term = search.trim().toLowerCase();
  if (!term) return options;
  return options.filter(
    (opt) =>
      opt.value.toLowerCase().includes(term) ||
      (opt.label ?? "").toLowerCase().includes(term),
  );
}

/**
 * Whether to offer the typed search text as a committable free value.
 *
 * Only loader-backed fields treat their options as suggestions rather than a
 * closed set: a dynamic `@options` loader, no fixed schema `enum`, and not the
 * constrained icon-select. For those, a value the loader doesn't return (e.g. a
 * Collection ID the search can't find, or a loader that came back empty) can
 * still be entered by hand.
 *
 * Gated on `optionsSettled` so the offer never appears while the loader is
 * still fetching — otherwise a user searching for a real option could
 * Enter-commit the raw text over the results about to load. Suppressed when the
 * typed value already exists as an option; dedupe against the full resolved
 * list (`optionValues`), not the filtered view — an exact value match always
 * survives client-side filtering, so it can never be hidden.
 */
export function shouldOfferTypedValue({
  loaderPath,
  isIconSelect,
  enumFallbackCount,
  trimmedSearch,
  optionValues,
  optionsSettled,
}: {
  loaderPath: string | undefined;
  isIconSelect: boolean;
  enumFallbackCount: number;
  trimmedSearch: string;
  optionValues: string[];
  optionsSettled: boolean;
}): boolean {
  const allowFreeValue =
    !!loaderPath && !isIconSelect && enumFallbackCount === 0;
  return (
    allowFreeValue &&
    optionsSettled &&
    trimmedSearch.length > 0 &&
    !optionValues.includes(trimmedSearch)
  );
}

/**
 * Data URI for an option's inline-SVG preview. Rendered through an `img` so
 * loader-controlled markup is never injected into the document. Loader SVGs
 * rely on Tailwind's current-color utilities (e.g. odin-ui color swatches are
 * `<circle class="fill-current"/>` with `style="color: #hex"` on the root);
 * inside an isolated SVG document those classes have no CSS, so the shim
 * defines them — without it every swatch falls back to a black fill.
 *
 * `color` is the fallback `currentColor` for the SVG document: isolated SVG
 * documents default `currentColor` to black, which makes monochrome icon
 * sets (e.g. odin-ui icons with `fill="currentColor"`) invisible on a dark
 * theme. A stylesheet rule loses to an inline `style` attribute, so swatches
 * that set their own `style="color: #hex"` on the root are unaffected.
 */
export function svgPreviewDataUri(svg: string, color?: string): string {
  const colorRule = color ? `svg{color:${color}}` : "";
  const shim = `<style>${colorRule}.fill-current{fill:currentColor}.stroke-current{stroke:currentColor}.text-current{color:currentColor}</style>`;
  const shimmed = svg.replace(/(<svg[^>]*>)/i, `$1${shim}`);
  return `data:image/svg+xml;utf8,${encodeURIComponent(shimmed)}`;
}

/**
 * The app's foreground token, so monochrome `currentColor` icon previews match
 * the theme (white on the dark theme). Reads the `--foreground` design-system
 * variable, which flips with the `.dark` class on `<html>`. Reading the raw
 * `color` of `<html>` instead is wrong — the theme sets its foreground via this
 * variable, not the element's `color`, so `<html>.color` stays the default black
 * and would render every icon black (invisible on the dark theme).
 */
function themeForegroundColor(): string | undefined {
  const fg = getComputedStyle(document.documentElement)
    .getPropertyValue("--foreground")
    .trim();
  return fg || undefined;
}

/**
 * Preview image source for an option: a pre-rendered `previewSrc`, else an
 * `image` URL, else an inline `icon` SVG encoded with the theme `fg` color.
 */
function optionPreviewSrc(
  opt: DynamicOption,
  fg: string | undefined,
): string | undefined {
  if (opt.previewSrc) return opt.previewSrc;
  if (opt.image) return opt.image;
  if (opt.icon) return svgPreviewDataUri(opt.icon, fg);
  return undefined;
}

async function fetchDynamicOptions(
  previewUrl: string,
  loaderPath: string,
  term?: string,
): Promise<DynamicOption[]> {
  const payload: Record<string, unknown> = {};
  if (term) {
    payload.term = term;
  }
  const base = previewUrl.replace(/\/+$/, "");
  const url = `${base}/deco/invoke/${loaderPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch dynamic options: ${res.status}`);
  }
  const data = await res.json();
  return normalizeOptions(data);
}

function OptionPreview({
  option,
  className,
  fg,
}: {
  option: DynamicOption;
  className?: string;
  fg: string | undefined;
}) {
  const src = optionPreviewSrc(option, fg);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className={cn(
        "shrink-0",
        option.image ? "rounded object-cover" : "object-contain",
        className,
      )}
    />
  );
}

function FieldHeader({
  path,
  label,
  description,
}: {
  path: string;
  label: string;
  description?: string;
}) {
  return (
    <div className="space-y-0.5">
      <Label htmlFor={path}>{label}</Label>
      {description && (
        <p className="text-xs leading-normal text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

export function DynamicOptionsField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
}: FieldProps) {
  const t = useT();
  const loaderPath = schema.options;
  const previewUrl = sandbox?.previewUrl;
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

  const sandboxKey = sandbox
    ? `${sandbox.orgSlug}/${sandbox.virtualMcpId}/${sandbox.branch}`
    : "";

  const currentValue = typeof value === "string" ? value : "";

  // icon-select works across runtimes: Deno/Fresh (and other sites that still
  // ship the `availableIcons` loader) resolve icons through the `@options`
  // loader as usual; on TanStack sites that loader is deleted during migration
  // (its resolveType 404s), so we fall back to the schema `enum` for the list
  // and the site's own `/sprites.svg` (see icon-sprite.ts) for the previews.
  const isIconSelect = schema.format === "icon-select";

  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(
      sandboxKey,
      `dynamic-options:${loaderPath ?? ""}:${debouncedSearch}`,
    ),
    queryFn: () =>
      fetchDynamicOptions(
        previewUrl!,
        loaderPath!,
        debouncedSearch || undefined,
      ),
    // Fetch eagerly when a value is already selected so its preview (icon /
    // swatch / label) shows on the closed trigger, not only after opening.
    enabled: !!previewUrl && !!loaderPath && (open || !!currentValue),
    staleTime: 60_000,
    retry: 1,
  });

  const loaderOptions = query.data ?? [];

  // Reach for the site sprite only when the loader can't supply icons: either
  // there's no `@options` loader (TanStack, where it's deleted) or the loader
  // has settled with nothing. Gating on `query.isFetched` (not just an empty
  // `loaderOptions`, which is also empty while the loader is in flight) is what
  // keeps a working-loader site from fetching the sprite concurrently.
  const spriteQuery = useQuery({
    queryKey: KEYS.sandboxSprite(sandboxKey),
    queryFn: () =>
      fetchSpriteIcons(
        buildPreviewFetchUrl(
          {
            orgSlug: sandbox!.orgSlug,
            virtualMcpId: sandbox!.virtualMcpId,
            branch: sandbox!.branch,
            previewUrl,
          },
          "/sprites.svg",
        ),
      ),
    enabled:
      isIconSelect &&
      !!sandbox &&
      (open || !!currentValue) &&
      (!loaderPath || (query.isFetched && loaderOptions.length === 0)),
    staleTime: 300_000,
    retry: 1,
  });

  const enumFallback = enumFallbackOptions(schema.enum);
  const spriteIcons = spriteQuery.data ?? {};
  // Read the theme foreground once per render (a getComputedStyle style read)
  // instead of once per option inside OptionPreview.
  const fg = themeForegroundColor();
  // Encode each sprite icon to a data-URI exactly once. Both inputs are stable
  // across renders (react-query's data ref + the fg string value), so the React
  // Compiler memoizes this — without it a 100+ icon list would re-encode every
  // SVG on every keystroke.
  const spriteSrcByValue = Object.fromEntries(
    Object.entries(spriteIcons).map(([name, svg]) => [
      name,
      svgPreviewDataUri(svg, fg),
    ]),
  );
  // Enum is the fallback list; on icon-select each name carries its already
  // encoded sprite preview so the picker shows the icon, not just the label.
  const enumOptions =
    isIconSelect && Object.keys(spriteSrcByValue).length > 0
      ? enumFallback.map((opt) => ({
          ...opt,
          previewSrc: spriteSrcByValue[opt.value],
        }))
      : enumFallback;
  // Loader wins when it returns anything (Fresh/Deno); otherwise the enum
  // (+ sprite previews for icon-select).
  const options = resolveOptions(loaderOptions, enumOptions);
  const visibleOptions = filterOptions(options, search);
  const selectedOption = options.find((opt) => opt.value === currentValue);

  // Offer the typed text as a committable free value on loader-backed fields
  // (see `shouldOfferTypedValue`). cmdk owns the input, so it's surfaced as a
  // selectable "use this" item rather than a separate text box; when it's the
  // only item cmdk highlights it, so Enter commits it and an empty result set
  // no longer traps the user. `optionsSettled` keeps the offer from appearing
  // (and preempting an incoming loader result) during the debounce + fetch
  // window: the query for a new term returns no data until it settles.
  const trimmedSearch = search.trim();
  const optionsSettled =
    query.isFetched && !query.isFetching && search === debouncedSearch;
  const canUseTypedValue = shouldOfferTypedValue({
    loaderPath,
    isIconSelect,
    enumFallbackCount: enumFallback.length,
    trimmedSearch,
    optionValues: options.map((opt) => opt.value),
    optionsSettled,
  });

  // Fallback to text input only when there's no option source at all: no
  // loader/preview to fetch from AND no schema enum to list.
  const noOptionSource =
    (!previewUrl || !loaderPath) && enumFallback.length === 0;
  if (noOptionSource) {
    return (
      <div className="space-y-2">
        <FieldHeader
          path={path}
          label={label}
          description={schema.description}
        />
        <Input
          id={path}
          type="text"
          value={currentValue}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <FieldHeader path={path} label={label} description={schema.description} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-10 w-full justify-between font-normal"
          >
            {selectedOption ? (
              <span className="flex min-w-0 items-center gap-2">
                <OptionPreview
                  option={selectedOption}
                  className="h-6 w-6"
                  fg={fg}
                />
                <span className="truncate">
                  {selectedOption.label ?? selectedOption.value}
                </span>
              </span>
            ) : currentValue ? (
              <span className="truncate">{currentValue}</span>
            ) : (
              <span className="text-muted-foreground">
                {t("sectionsEditor.dynamicOptionsField.selectPlaceholder")}
              </span>
            )}
            <ChevronSelectorVertical className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0"
          style={{ width: "var(--radix-popover-trigger-width)" }}
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t(
                "sectionsEditor.dynamicOptionsField.searchPlaceholder",
              )}
              className="h-9"
              value={search}
              onValueChange={handleSearchChange}
            />
            <CommandList>
              {!canUseTypedValue && (
                <CommandEmpty>
                  {query.isLoading
                    ? t("sectionsEditor.dynamicOptionsField.loading")
                    : t("sectionsEditor.dynamicOptionsField.noResults")}
                </CommandEmpty>
              )}
              <CommandGroup>
                {visibleOptions.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    className="cursor-pointer"
                    onSelect={() => {
                      onChange(opt.value === currentValue ? "" : opt.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <OptionPreview
                        option={opt}
                        className={cn(opt.image ? "h-9 w-9" : "h-6 w-6")}
                        fg={fg}
                      />
                      <span className="truncate">{opt.label ?? opt.value}</span>
                    </span>
                    <Check
                      className={cn(
                        "ml-auto size-4 shrink-0",
                        currentValue === opt.value
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
              {canUseTypedValue && (
                <CommandGroup>
                  <CommandItem
                    value={trimmedSearch}
                    className="cursor-pointer"
                    onSelect={() => {
                      onChange(trimmedSearch);
                      setSearch("");
                      setDebouncedSearch("");
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">
                      {t("sectionsEditor.dynamicOptionsField.useValue", {
                        value: trimmedSearch,
                      })}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
