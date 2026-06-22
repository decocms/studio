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
import type { FieldProps } from "./field-props";

interface DynamicOption {
  value: string;
  label?: string;
  image?: string;
}

function normalizeOptions(data: unknown): DynamicOption[] {
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
      });
    }
  }
  return result;
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
  console.log("[DynamicOptions] fetching", { url, payload });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("[DynamicOptions] fetch failed", res.status, res.statusText);
    throw new Error(`Failed to fetch dynamic options: ${res.status}`);
  }
  const data = await res.json();
  console.log("[DynamicOptions] raw response", data);
  const normalized = normalizeOptions(data);
  console.log("[DynamicOptions] normalized options", normalized);
  return normalized;
}

export function DynamicOptionsField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
}: FieldProps) {
  const loaderPath = schema.options;
  const previewUrl = sandbox?.previewUrl;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  console.log("[DynamicOptions] render", {
    path,
    format: schema.format,
    options: schema.options,
    loaderPath,
    previewUrl,
    hasSandbox: !!sandbox,
    value,
  });

  const sandboxKey = sandbox
    ? `${sandbox.orgSlug}/${sandbox.virtualMcpId}/${sandbox.branch}`
    : "";

  const [debouncedSearch, setDebouncedSearch] = useState("");

  const handleSearchChange = (next: string) => {
    setSearch(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(next);
    }, 300);
  };

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
    enabled: !!previewUrl && !!loaderPath,
    staleTime: 60_000,
    retry: 1,
  });

  const options = query.data ?? [];
  const currentValue = typeof value === "string" ? value : "";
  const selectedOption = options.find((opt) => opt.value === currentValue);

  // Fallback to text input when preview is not available
  if (!previewUrl || !loaderPath) {
    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label htmlFor={path}>{label}</Label>
          {schema.description && (
            <p className="text-xs leading-normal text-muted-foreground">
              {schema.description}
            </p>
          )}
        </div>
        <Input
          id={path}
          type="text"
          value={currentValue}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  // No options available and not loading — show text input fallback
  if (options.length === 0 && !query.isLoading) {
    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label htmlFor={path}>{label}</Label>
          {schema.description && (
            <p className="text-xs leading-normal text-muted-foreground">
              {schema.description}
            </p>
          )}
        </div>
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
      <div className="space-y-0.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>
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
                {selectedOption.image && (
                  <img
                    src={selectedOption.image}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-6 w-6 shrink-0 rounded object-cover"
                  />
                )}
                <span className="truncate">
                  {selectedOption.label ?? selectedOption.value}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {query.isLoading ? "Loading..." : "Select..."}
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
              placeholder="Search..."
              className="h-9"
              value={search}
              onValueChange={handleSearchChange}
            />
            <CommandList>
              <CommandEmpty>
                {query.isLoading ? "Loading..." : "No results found."}
              </CommandEmpty>
              <CommandGroup>
                {options.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    onSelect={() => {
                      onChange(opt.value === currentValue ? "" : opt.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {opt.image && (
                        <img
                          src={opt.image}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="h-9 w-9 shrink-0 rounded object-cover"
                        />
                      )}
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
