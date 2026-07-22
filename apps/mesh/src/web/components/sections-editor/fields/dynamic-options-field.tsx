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
import { KEYS } from "@/web/lib/query-keys";
import { useT } from "@/web/i18n/use-t.ts";
import type { FieldProps } from "./field-props";

export interface DynamicOption {
  value: string;
  label?: string;
  image?: string;
  /** Inline SVG markup for the option preview (deco `icon-select` loaders). */
  icon?: string;
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

/** The app's current foreground color, so icon previews match the theme. */
function themeForegroundColor(): string | undefined {
  const color = getComputedStyle(document.documentElement).color;
  return color || undefined;
}

/** Preview image source for an option: `image` is a URL, `icon` inline SVG. */
function optionPreviewSrc(opt: DynamicOption): string | undefined {
  if (opt.image) return opt.image;
  if (opt.icon) return svgPreviewDataUri(opt.icon, themeForegroundColor());
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
}: {
  option: DynamicOption;
  className?: string;
}) {
  const src = optionPreviewSrc(option);
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

  const options = query.data ?? [];
  const visibleOptions = filterOptions(options, search);
  const selectedOption = options.find((opt) => opt.value === currentValue);

  // Fallback to text input when preview is not available
  if (!previewUrl || !loaderPath) {
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
                <OptionPreview option={selectedOption} className="h-6 w-6" />
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
              <CommandEmpty>
                {query.isLoading
                  ? t("sectionsEditor.dynamicOptionsField.loading")
                  : t("sectionsEditor.dynamicOptionsField.noResults")}
              </CommandEmpty>
              <CommandGroup>
                {visibleOptions.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    onSelect={() => {
                      onChange(opt.value === currentValue ? "" : opt.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <OptionPreview
                        option={opt}
                        className={cn(opt.image ? "h-9 w-9" : "h-6 w-6")}
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
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
