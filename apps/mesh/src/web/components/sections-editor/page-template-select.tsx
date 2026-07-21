"use client";

import { useState } from "react";
import { Check, ChevronSelectorVertical } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
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
import { useT } from "@/web/i18n/use-t.ts";
import type { PageEntry } from "./page-list";

/** Sentinel value for "start from a blank page". */
export const BLANK_TEMPLATE = "__blank__";

/**
 * Searchable template picker for the create-page dialogs. Shows each page's
 * name and path, and filters by either as you type. The "Blank page" entry is
 * always first and is the default.
 */
export function PageTemplateSelect({
  id,
  value,
  onChange,
  templates,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  templates: PageEntry[];
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = templates.find((t) => t.key === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {selected?.name ??
                t("sectionsEditor.pageTemplateSelect.blankPageDefaultLabel")}
            </span>
            {selected?.path ? (
              <span className="truncate text-muted-foreground">
                {selected.path}
              </span>
            ) : null}
          </span>
          <ChevronSelectorVertical className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command>
          <CommandInput
            placeholder={t(
              "sectionsEditor.pageTemplateSelect.searchPlaceholder",
            )}
            className="h-9"
          />
          <CommandList
            // The popover is portalled outside the Dialog, so Radix's
            // react-remove-scroll blocks wheel events over it (scrollbar drag
            // still works). Scroll the list ourselves to restore the wheel.
            // deltaMode 1 is line-based (Firefox); scale to approx pixels.
            onWheel={(e) => {
              const factor = e.deltaMode === 1 ? 16 : 1;
              e.currentTarget.scrollTop += e.deltaY * factor;
            }}
          >
            <CommandEmpty>
              {t("sectionsEditor.pageTemplateSelect.noPagesFoundMessage")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t("sectionsEditor.pageTemplateSelect.blankPageLabel")}
                onSelect={() => {
                  onChange(BLANK_TEMPLATE);
                  setOpen(false);
                }}
              >
                {t("sectionsEditor.pageTemplateSelect.blankPageLabel")}
                <Check
                  className={cn(
                    "ml-auto",
                    value === BLANK_TEMPLATE ? "opacity-100" : "opacity-0",
                  )}
                />
              </CommandItem>
              {templates.map((t) => (
                <CommandItem
                  // Search on human text, not the `pages-<uuid>` key (whose
                  // prefix + hex would create spurious matches). Selection
                  // uses t.key directly, so the display value is free to differ.
                  key={t.key}
                  value={`${t.name} ${t.path}`}
                  onSelect={() => {
                    onChange(t.key);
                    setOpen(false);
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{t.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {t.path}
                    </span>
                  </div>
                  <Check
                    className={cn(
                      "ml-auto",
                      value === t.key ? "opacity-100" : "opacity-0",
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
