import { useState } from "react";
import { Check, ChevronSelectorVertical } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { FieldLabel } from "./field-label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { FieldProps } from "./field-props";
import { BrazilMap } from "./location/brazil-map";
import { BRAZIL_STATES } from "./location/brazil-states";
import { BRAZIL_COUNTRY_CODE, COUNTRIES } from "./location/countries";
import {
  mergeLocationValue,
  readLocationValue,
} from "./location/location-value";

interface ComboboxOption {
  value: string;
  label: string;
}

/** Searchable single-select. cmdk filters on the visible label + value. */
function Combobox({
  id,
  options,
  value,
  placeholder,
  emptyMessage,
  onChange,
}: {
  id: string;
  options: readonly ComboboxOption[];
  value: string;
  placeholder: string;
  emptyMessage: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((opt) => opt.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-10 w-full justify-between font-normal"
        >
          {selected ? (
            <span className="truncate">{selected.label}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronSelectorVertical className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command>
          <CommandInput placeholder={placeholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  // Include the code so searching "SP" or "Brazil" both hit.
                  value={`${opt.label} ${opt.value}`}
                  onSelect={() => {
                    onChange(opt.value === value ? "" : opt.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{opt.label}</span>
                  <Check
                    className={cn(
                      "ml-auto size-4 shrink-0",
                      value === opt.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const COUNTRY_OPTIONS: ComboboxOption[] = COUNTRIES.map((c) => ({
  value: c.code,
  label: `${c.name} (${c.code})`,
}));

const BRAZIL_STATE_OPTIONS: ComboboxOption[] = BRAZIL_STATES.map((s) => ({
  value: s.code,
  label: `${s.name} (${s.code})`,
}));

/**
 * Widget for `@format location` (the `Location` matcher interface). Renders a
 * cascading country → region → city picker. Country values are ISO 3166-1
 * alpha-2 codes (cf-ipcountry); when Brazil is selected the region step becomes
 * an interactive map. City is free text since Cloudflare's cf-ipcity is an
 * arbitrary string matched exactly.
 */
export function LocationField({
  schema,
  value,
  onChange,
  path,
  sandbox,
}: FieldProps) {
  const t = useT();
  const current = readLocationValue(value);
  const { city, regionCode, country } = current;
  const props = schema.properties ?? {};
  const countryLabel =
    props.country?.title ?? t("sectionsEditor.locationField.countryDefault");
  const regionLabel =
    props.regionCode?.title ?? t("sectionsEditor.locationField.regionDefault");
  const cityLabel =
    props.city?.title ?? t("sectionsEditor.locationField.cityDefault");

  const emit = (next: Partial<typeof current>) => {
    onChange(mergeLocationValue(current, next));
  };

  const isBrazil = country === BRAZIL_COUNTRY_CODE;
  const selectedState = BRAZIL_STATES.find((s) => s.code === regionCode);

  return (
    <div className="space-y-4">
      <FieldLabel
        htmlFor={`${path}.country`}
        label={
          schema.title ?? t("sectionsEditor.locationField.locationDefault")
        }
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />

      {/* Step 1 — country */}
      <div className="space-y-1.5">
        <Label htmlFor={`${path}.country`} className="text-xs">
          {countryLabel}
        </Label>
        <Combobox
          id={`${path}.country`}
          options={COUNTRY_OPTIONS}
          value={country}
          placeholder={t(
            "sectionsEditor.locationField.selectCountryPlaceholder",
          )}
          emptyMessage={t("sectionsEditor.locationField.noCountryFound")}
          onChange={(next) =>
            // Region/city depend on the country, so reset them on change.
            emit({ country: next, regionCode: "", city: "" })
          }
        />
      </div>

      {/* Step 2 — region (only once a country is chosen) */}
      {country && (
        <div className="space-y-1.5">
          <Label htmlFor={`${path}.regionCode`} className="text-xs">
            {regionLabel}
          </Label>
          {isBrazil ? (
            <div className="space-y-2">
              <BrazilMap
                selected={regionCode}
                onSelect={(code) =>
                  emit({
                    regionCode: code === regionCode ? "" : code,
                    city: "",
                  })
                }
              />
              <Combobox
                id={`${path}.regionCode`}
                options={BRAZIL_STATE_OPTIONS}
                value={regionCode}
                placeholder={t(
                  "sectionsEditor.locationField.selectStatePlaceholder",
                )}
                emptyMessage={t("sectionsEditor.locationField.noStateFound")}
                onChange={(next) => emit({ regionCode: next, city: "" })}
              />
            </div>
          ) : (
            <>
              <Input
                id={`${path}.regionCode`}
                type="text"
                value={regionCode}
                placeholder={t(
                  "sectionsEditor.locationField.regionCodePlaceholder",
                )}
                onChange={(e) => emit({ regionCode: e.target.value })}
              />
              <p className="text-xs leading-normal text-muted-foreground">
                {t("sectionsEditor.locationField.regionCodeHelperText")}
              </p>
            </>
          )}
        </div>
      )}

      {/* Step 3 — city (only once a country is chosen) */}
      {country && (
        <div className="space-y-1.5">
          <Label htmlFor={`${path}.city`} className="text-xs">
            {cityLabel}
          </Label>
          <Input
            id={`${path}.city`}
            type="text"
            value={city}
            placeholder={
              isBrazil && selectedState
                ? t("sectionsEditor.locationField.cityPlaceholderWithState", {
                    state: selectedState.name,
                  })
                : t("sectionsEditor.locationField.cityPlaceholder")
            }
            onChange={(e) => emit({ city: e.target.value })}
          />
          <p className="text-xs leading-normal text-muted-foreground">
            {t("sectionsEditor.locationField.cityHelperText")}
          </p>
        </div>
      )}
    </div>
  );
}
